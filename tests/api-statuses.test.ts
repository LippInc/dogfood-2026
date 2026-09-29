import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { OPERATIONS, openApiDocument, type Operation } from "@/server/openapi";
import { statusReader, type Found } from "./support/route-statuses";

// The API reference (src/server/openapi.ts) must name every status each route can answer, and only those. The
// statuses a handler can answer are read from the code (tests/support/route-statuses.ts): its own json(..., status)
// and Response answers, and every error thrown by what it calls, down to authorize()'s refusals; plus the proxy's
// 403 for a cross-origin write that would set a cookie (src/proxy.ts). tests/api-registry.test.ts already holds each
// route file's exported methods to an entry.
//
// When this fails for your route: an answer the reference lacks goes in its entry (ok, also, or answers with what it
// means); an implied one it never gives goes in never. A status the reader finds on a path that cannot happen goes
// in UNREACHABLE below with the reason.

const ROOT = process.cwd();
/** Answered by route() for anything unexpected; not a promise, so not documented. */
const UNDOCUMENTED = new Set([500]);

/** Statuses the reader finds that the route can never give, each with why. */
const UNREACHABLE: Record<string, Record<number, string>> = {
  "DELETE /api/events/{event}/judges/{judge}/override": { 422: "the only field is the {judge} path part, which is never empty" },
  "DELETE /api/events/{event}/projects/{project}/accept-under-reviewed": { 422: "the only field is the {project} path part, which is never empty" },
  "POST /api/events/{event}/voting/voters/{voter}/restore": { 422: "the only field is the {voter} path part, which is never empty" },
};

const key = (op: Pick<Operation, "method" | "path">) => `${op.method} ${op.path}`;

function routeFile(p: string): string {
  const parts = p.replace(/^\//, "").split("/").map((s) => s.replace(/^\{(\w+)\}$/, "[$1]"));
  return path.join(ROOT, "src", "app", ...parts, "route.ts");
}

/** The proxy's answer to a browser write from another origin, which it refuses when the route would set a cookie. */
function proxyRefuses(op: Operation): boolean {
  if (op.method === "GET") return false;
  const url = `http://localhost:8080${op.path.replace(/\{(\w+)\}/g, "$1-x")}`;
  const res = proxy(new NextRequest(url, { method: op.method, headers: { host: "localhost:8080", "sec-fetch-site": "cross-site" } }));
  return res.status === 403;
}

function documented(ops: Operation[]): Map<string, number[]> {
  const doc = openApiDocumentFor(ops);
  return new Map(ops.map((op) => [key(op), Object.keys(doc.paths[op.path]![op.method.toLowerCase()]!.responses).map(Number)]));
}

function openApiDocumentFor(ops: Operation[]) {
  // openApiDocument reads OPERATIONS; a planted drift swaps entries in place and puts them back
  const saved = OPERATIONS.splice(0, OPERATIONS.length, ...ops);
  try {
    return openApiDocument("http://localhost:8080") as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
  } finally {
    OPERATIONS.splice(0, OPERATIONS.length, ...saved);
  }
}

type Drift = { missing: string[]; unkept: string[]; unreadable: string[]; staleExemptions: string[] };

function drift(ops: Operation[], found: Map<string, Found>): Drift {
  const docs = documented(ops);
  const out: Drift = { missing: [], unkept: [], unreadable: [], staleExemptions: [] };
  for (const op of ops) {
    const k = key(op);
    const f = found.get(k)!;
    const listed = docs.get(k)!;
    const exempt = UNREACHABLE[k] ?? {};
    for (const [status, at] of f.statuses) {
      if (UNDOCUMENTED.has(status) || status in exempt || listed.includes(status)) continue;
      out.missing.push(`${k} can answer ${status} (${at}); src/server/openapi.ts does not list it: add it to the entry's also, answers or ok`);
    }
    for (const status of listed) {
      if (!f.statuses.has(status)) out.unkept.push(`${k} lists ${status}, but no code path of the handler answers it: take it out (never: [${status}] for an implied one) or fix the handler`);
    }
    for (const status of Object.keys(exempt).map(Number)) {
      if (!f.statuses.has(status) || listed.includes(status)) out.staleExemptions.push(`${k} ${status} in UNREACHABLE: the reader no longer finds it, or the reference lists it`);
    }
    out.unreadable.push(...f.unreadable.map((u) => `${k}: cannot tell the status at ${u}`));
  }
  return out;
}

describe("the API reference lists every status each route answers, and only those", () => {
  const found = new Map<string, Found>();
  let reader: ReturnType<typeof statusReader>;

  beforeAll(() => {
    const files = [...new Set(OPERATIONS.map((o) => routeFile(o.path)).filter((f) => fs.existsSync(f)))];
    reader = statusReader(ROOT, [...files, path.join(ROOT, "tests", "support", "drift-route.fixture.ts")]);
    for (const op of OPERATIONS) {
      const f = reader.statusesOf(routeFile(op.path), op.method);
      if (!f) continue;
      if (proxyRefuses(op) && !f.statuses.has(403)) f.statuses.set(403, "src/proxy.ts (cross_origin)");
      found.set(key(op), f);
    }
  }, 120_000);

  it("every documented operation's handler was read, and the reading found something", () => {
    const unread = OPERATIONS.filter((op) => !found.has(key(op))).map(key);
    expect(unread).toEqual([]);
    expect(found.size).toBeGreaterThan(90);
    expect([...found.values()].every((f) => f.statuses.size > 0)).toBe(true);
  });

  it("no drift: every status found is documented, every documented status is found", () => {
    const d = drift(OPERATIONS, found);
    expect(d.unreadable).toEqual([]);
    expect(d.staleExemptions).toEqual([]);
    expect(d.missing).toEqual([]);
    expect(d.unkept).toEqual([]);
  });

  it("known-bad: a status dropped from an entry, and one it invents, are both named with where the code gives it", () => {
    const join = OPERATIONS.find((o) => key(o) === "POST /api/join/{code}")!;
    const events = OPERATIONS.find((o) => key(o) === "GET /api/events")!;
    const planted = OPERATIONS.map((o) => (o === join ? { ...o, also: [] } : o === events ? { ...o, also: [409] } : o));
    const d = drift(planted.filter((op) => found.has(key(op))), found);
    expect(d.missing).toEqual([expect.stringMatching(/^POST \/api\/join\/\{code\} can answer 409 \(src\/server\/dal\/teams\.ts:\d+\)/)]);
    expect(d.unkept).toEqual([expect.stringMatching(/^GET \/api\/events lists 409, but no code path/)]);
  });

  it("known-bad: the reader finds a handler's own statuses, a helper's HttpError and a DAL error class", () => {
    const f = reader.statusesOf(path.join(ROOT, "tests", "support", "drift-route.fixture.ts"), "POST")!;
    expect([...f.statuses.keys()].sort()).toEqual([200, 202, 409, 410, 500]);
    expect(f.statuses.get(409)).toMatch(/^tests\/support\/drift-route\.fixture\.ts:\d+$/);
    expect(f.unreadable).toEqual([]);
  });

  it("known-bad: the proxy's cross-origin refusal counts for the routes that set a cookie, and only those", () => {
    const refused = OPERATIONS.filter(proxyRefuses).map(key).sort();
    expect(refused).toEqual([
      "POST /api/auth/demo-sign-in",
      "POST /api/auth/sign-in",
      "POST /api/auth/sign-up",
      "POST /api/claims/{token}",
      "POST /api/password-resets/{token}",
      "POST /api/vote/{code}",
    ]);
  });
});
