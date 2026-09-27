import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The API First promise: "every action available in the UI is available through a documented API".
// A UI action is a server action (src/app/**/actions.ts); what it does, it does through the data
// access layer. So every data-layer function a server action calls must also be called by some API
// route handler (src/app/api/**/route.ts); tests/api-registry.test.ts then holds every route to a
// documented operation. Helpers that are not actions are named here, each with its reason.
const NOT_ACTIONS: Record<string, string> = {
  actionError: "turns a thrown error into the form's message",
  homeFor: "where a browser lands after signing in; the API answers with the user id instead",
};

const ROOT = process.cwd();

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel, keep));
    else if (keep(rel)) out.push(rel);
  }
  return out;
}

/** The data-layer functions a file imports from the barrel and calls. */
function dalCalls(file: string): Set<string> {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const names = new Set<string>();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@\/server\/dal"/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (name && !name.startsWith("type ") && new RegExp(`\\b${name}\\s*\\(`).test(text)) names.add(name);
    }
  }
  return names;
}

/** Data-layer functions some UI action calls and no API route does. */
function withoutRoute(actionFiles: string[], routeFiles: string[]): string[] {
  const byRoutes = new Set(routeFiles.flatMap((f) => [...dalCalls(f)]));
  const byActions = new Set(actionFiles.flatMap((f) => [...dalCalls(f)]));
  return [...byActions].filter((name) => !byRoutes.has(name) && !(name in NOT_ACTIONS)).sort();
}

const actionFiles = walk("src/app", (f) => /actions\.ts$/.test(f));
const routeFiles = walk(path.join("src", "app", "api"), (f) => f.endsWith("route.ts"));

describe("API first: every action in the UI has an API route", () => {
  it("every data-layer function a server action calls is also called by an API route handler", () => {
    expect(actionFiles.length).toBeGreaterThan(10);
    expect(routeFiles.length).toBeGreaterThan(50);
    const called = new Set(actionFiles.flatMap((f) => [...dalCalls(f)]));
    expect(called.size).toBeGreaterThan(40);
    expect(withoutRoute(actionFiles, routeFiles)).toEqual([]);
  });

  it("known-bad: without the demo sign-in route, the check names signInAsDemo", () => {
    const fewer = routeFiles.filter((f) => !f.includes(path.join("auth", "demo-sign-in")));
    expect(fewer.length).toBe(routeFiles.length - 1);
    expect(withoutRoute(actionFiles, fewer)).toEqual(["signInAsDemo"]);
  });
});
