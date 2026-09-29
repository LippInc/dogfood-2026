import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { ensureDemoOrganizer } from "@/server/checker";
import { openApiDocument } from "@/server/openapi";

// The reference's general words must be true of the code: it said "Every answer is JSON" while the CSV exports
// answer text/csv, named one of the two headers that make sign-out redirect, and gave 422 a meaning (a body failed
// validation) that did not cover the routes refusing a query parameter with it. Each claim is checked here against
// what the route actually does.

let requestHeaders = new Headers();
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(() => undefined), delete: vi.fn() }),
  headers: async () => requestHeaders,
}));

const { POST: signOut } = await import("@/app/api/auth/sign-out/route");
const { GET: exportFile } = await import("@/app/api/events/[event]/export/[file]/route");
const { GET: listProjects } = await import("@/app/api/events/[event]/projects/route");
const { createLoginSession } = await import("@/server/session");

type Doc = ReturnType<typeof openApiDocument>;
type Responses = Record<string, { description: string }>;
const doc: Doc = openApiDocument("http://localhost:8080");
const responsesOf = (p: string, method: string) => (doc.paths[p]![method] as { responses: Responses }).responses;

let h: Handle;
beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: "2026-09-26T12:00:00.000Z" });
  ensureDemoOrganizer(h.db, "evt_01", "2026-09-26T12:00:00.000Z");
  setHandleForTests(h);
  requestHeaders = new Headers();
});
afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

describe("the API reference's general words", () => {
  it("says the CSV exports answer text/csv, as the export route does, and never that every answer is JSON", async () => {
    const organizer = createLoginSession(h.db, "usr_organizer").token;
    requestHeaders = new Headers({ authorization: `Bearer ${organizer}` });
    const res = await exportFile(new Request("http://localhost:8080/api/events/evt_01/export/scores.csv"), { params: Promise.resolve({ event: "evt_01", file: "scores.csv" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(doc.info.description).not.toMatch(/every answer is JSON/i);
    expect(doc.info.description).toMatch(/text\/csv/);
  });

  it("names both headers that make sign-out redirect, each of which does so alone", async () => {
    const triggers: Record<string, string>[] = [{ accept: "text/html" }, { "sec-fetch-mode": "navigate" }];
    for (const trigger of triggers) {
      const res = await signOut(new Request("http://localhost:8080/api/auth/sign-out", { method: "POST", headers: trigger }));
      expect(res.status, JSON.stringify(trigger)).toBe(303);
    }
    const redirect = responsesOf("/api/auth/sign-out", "post")["303"]!.description;
    for (const words of [doc.info.description, redirect]) {
      expect(words).toMatch(/Accept: text\/html/);
      expect(words).toMatch(/Sec-Fetch-Mode: navigate/);
    }
  });

  it("declares the export's two kinds of answer, and nowhere says the whole interface answers as JSON", async () => {
    const ok = responsesOf("/api/events/{event}/export/{file}", "get")["200"] as { content?: Record<string, unknown> };
    expect(Object.keys(ok.content ?? {}).sort()).toEqual(["application/json", "text/csv"]);
    expect(doc.info.description).not.toMatch(/interface, as JSON/i);
    const fs = await import("node:fs");
    const page = fs.readFileSync(path.join(process.cwd(), "src/app/api-docs/page.tsx"), "utf-8");
    expect(page).not.toMatch(/does, as JSON/);
    expect(page).toMatch(/text\/csv/);
  });

  it("gives 422 a meaning that covers a query parameter, as GET /api/events/{event}/projects refuses one", async () => {
    const res = await listProjects(new Request("http://localhost:8080/api/events/evt_01/projects?track=no_such_track"), { params: Promise.resolve({ event: "evt_01" }) });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details: Record<string, unknown> }).details).toHaveProperty("track");
    expect(responsesOf("/api/events/{event}/projects", "get")["422"]!.description).toMatch(/query parameter/);
  });
});
