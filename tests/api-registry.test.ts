import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATIONS, openApiDocument, operationId, type Operation } from "@/server/openapi";

// The API reference (src/server/openapi.ts) must list exactly the route handlers
// that exist: a route with no entry is undocumented, an entry with no route is a lie.

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? routeFiles(p) : d.name === "route.ts" ? [p] : [];
  });
}

/** "src/app/api/events/[event]/ballot/route.ts" exporting GET and PUT -> ["GET /api/events/{event}/ballot", "PUT ..."] */
export function handlersIn(root: string): string[] {
  const app = path.join(root, "src", "app");
  return [path.join(app, "api"), path.join(app, ".well-known")].flatMap((dir) =>
    routeFiles(dir).flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      const url =
        "/" +
        path
          .relative(app, path.dirname(file))
          .split(path.sep)
          .map((seg) => seg.replace(/^\[(\w+)\]$/, "{$1}"))
          .join("/");
      return METHODS.filter((m) => new RegExp(`export (async )?function ${m}[^A-Za-z0-9_]`).test(text)).map((m) => `${m} ${url}`);
    }),
  );
}

export function mismatch(handlers: string[], ops: Operation[]) {
  const listed = ops.map((o) => `${o.method} ${o.path}`);
  return {
    undocumented: handlers.filter((h) => !listed.includes(h)).sort(),
    noRoute: listed.filter((l) => !handlers.includes(l)).sort(),
  };
}

describe("the API reference matches the route handlers", () => {
  const handlers = handlersIn(process.cwd());

  it("every handler is documented and every documented operation has a handler", () => {
    expect(handlers.length).toBeGreaterThan(20);
    expect(mismatch(handlers, OPERATIONS)).toEqual({ undocumented: [], noRoute: [] });
  });

  it("known-bad: a missing entry and an invented one are both caught", () => {
    const [first, ...rest] = OPERATIONS;
    const invented: Operation = { method: "GET", path: "/api/nothing/here", tag: "x", summary: "x", access: "anyone" };
    const found = mismatch(handlers, [...rest, invented]);
    expect(found.undocumented).toEqual([`${first!.method} ${first!.path}`]);
    expect(found.noRoute).toEqual(["GET /api/nothing/here"]);
  });

  it("the document is OpenAPI 3.1 with unique operation ids, every path parameter declared, and a JSON schema for every body", () => {
    const doc = openApiDocument("http://localhost:8080");
    expect(doc.openapi).toBe("3.1.0");
    const ids = OPERATIONS.map(operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [p, methods] of Object.entries(doc.paths)) {
      const names = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const op of Object.values(methods) as { parameters?: { name: string }[]; requestBody?: { content: Record<string, { schema: { type?: string } }> } }[]) {
        expect((op.parameters ?? []).map((x) => x.name)).toEqual(names);
        if (op.requestBody) expect(["object", "array"]).toContain(op.requestBody.content["application/json"]!.schema.type);
      }
    }
    expect(() => JSON.stringify(doc)).not.toThrow();
  });
});
