import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The API First promise: "every action available in the UI is available through a documented API".
// A UI action is a server action (any file under src/app marked "use server"); what it does, it does through the
// data access layer. So every data-layer function a server action uses must also be called by some API route handler
// (src/app/api/**/route.ts); tests/api-registry.test.ts then holds every route to a documented operation. Helpers
// that are not actions are named here, each with its reason.
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

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

/**
 * The data-layer functions a file imports by value, as local name -> the barrel's name (an alias is followed back),
 * and the text without those imports. A namespace or default import of the barrel would hide what the file uses,
 * so it is refused outright. Only functions count: a capitalised name is a class, schema or constant.
 */
function dalImports(text: string, file: string): { imports: Map<string, string>; rest: string } {
  if (/import\s+(\*\s+as\s+\w+|\w+)\s*(,\s*\{[^}]*\})?\s*from\s*["']@\/server\/dal["']/.test(text)) {
    throw new Error(`${file}: import the data layer by name, not as a namespace or default, so its uses can be read`);
  }
  const imports = new Map<string, string>();
  let rest = text;
  for (const m of text.matchAll(/import\s*(type\s+)?\{([^}]*)\}\s*from\s*["']@\/server\/dal["']\s*;?/g)) {
    if (m[1]) continue; // import type { ... }: types only
    rest = rest.replace(m[0], "");
    for (const part of m[2]!.split(",")) {
      const spec = part.trim();
      // types, and classes, schemas and constants (capitalised: NotFoundError, ProjectInput), are not actions
      if (!spec || spec.startsWith("type ") || /^[A-Z]/.test(spec)) continue;
      const [name, local = name] = spec.split(/\s+as\s+/).map((s) => s!.trim());
      imports.set(local!, name!);
    }
  }
  return { imports, rest };
}

/**
 * What a server action uses: every imported data-layer function whose local name appears again after the import,
 * called or handed on (a wrapper taking the function counts), so an action cannot slip one past by wrapping it.
 */
function dalUses(text: string, file = "<text>"): Set<string> {
  const { imports, rest } = dalImports(text, file);
  const names = new Set<string>();
  for (const [local, name] of imports) {
    if (new RegExp(`(?<![\\w$.])${local.replace(/\$/g, "\\$")}(?![\\w$])`).test(rest)) names.add(name);
  }
  return names;
}

/**
 * What a route handler does: only the imported data-layer functions it calls, read from the syntax tree, so a name
 * in a comment, a string or a type (ReturnType<typeof saveX>) does not give an action its route.
 */
function dalCalls(text: string, file = "<text>"): Set<string> {
  const { imports } = dalImports(text, file);
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = imports.get(node.expression.text);
      if (name) names.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return names;
}

/** Data-layer functions some UI action uses and no API route calls. */
function withoutRoute(actions: [string, string][], routes: [string, string][]): string[] {
  const byRoutes = new Set(routes.flatMap(([f, text]) => [...dalCalls(text, f)]));
  const byActions = new Set(actions.flatMap(([f, text]) => [...dalUses(text, f)]));
  return [...byActions].filter((name) => !byRoutes.has(name) && !(name in NOT_ACTIONS)).sort();
}

const USE_SERVER = /^\s*["']use server["'];?\s*$/m;
const actionFiles = walk("src/app", (f) => /\.tsx?$/.test(f)).filter((f) => USE_SERVER.test(read(f)));
const routeFiles = walk(path.join("src", "app", "api"), (f) => f.endsWith("route.ts"));
const actions = actionFiles.map((f): [string, string] => [f, read(f)]);
const routes = routeFiles.map((f): [string, string] => [f, read(f)]);

describe("API first: every action in the UI has an API route", () => {
  it("every data-layer function a server action uses is also called by an API route handler", () => {
    expect(actionFiles.length).toBeGreaterThan(10);
    expect(routeFiles.length).toBeGreaterThan(50);
    const used = new Set(actions.flatMap(([f, text]) => [...dalUses(text, f)]));
    expect(used.size).toBeGreaterThan(40);
    expect(withoutRoute(actions, routes)).toEqual([]);
  });

  it("known-bad: without the demo sign-in route, the check names signInAsDemo", () => {
    const fewer = routes.filter(([f]) => !f.includes(path.join("auth", "demo-sign-in")));
    expect(fewer.length).toBe(routes.length - 1);
    expect(withoutRoute(actions, fewer)).toEqual(["signInAsDemo"]);
  });

  // Each planted action below does something no route does (hiddenPower). The first is what the old check read;
  // the next three are the shapes it missed: an alias, a function handed to a wrapper, and a server-action file
  // not named actions.ts. A namespace import is refused before it can hide anything.
  const planted = (file: string, text: string) => withoutRoute([...actions, [file, text]], routes);
  it("known-bad: a planted action calling a data-layer function no route uses is named", () => {
    expect(planted("src/app/x/actions.ts", `"use server";\nimport { hiddenPower } from "@/server/dal";\nexport async function go() { hiddenPower(1); }`)).toEqual(["hiddenPower"]);
  });
  it("known-bad: ... also under another name (an aliased import)", () => {
    expect(planted("src/app/x/actions.ts", `"use server";\nimport { hiddenPower as power, currentActor } from "@/server/dal";\nexport async function go() { await currentActor(); power(1); }`)).toEqual(["hiddenPower"]);
  });
  it("known-bad: ... also when handed to a wrapper instead of called", () => {
    expect(planted("src/app/x/actions.ts", `"use server";\nimport { hiddenPower } from "@/server/dal";\nconst run = (f: unknown) => f;\nexport const go = run(hiddenPower);`)).toEqual(["hiddenPower"]);
  });
  it("known-bad: ... also in a server-action file with another name", () => {
    const file = "src/app/x/forms.ts";
    const text = `'use server'\nimport { hiddenPower } from "@/server/dal";\nexport async function go() { hiddenPower(1); }`;
    expect(USE_SERVER.test(text)).toBe(true);
    expect(planted(file, text)).toEqual(["hiddenPower"]);
  });
  it("known-bad: a namespace import of the data layer is refused", () => {
    expect(() => planted("src/app/x/actions.ts", `"use server";\nimport * as dal from "@/server/dal";\nexport async function go() { dal.hiddenPower(1); }`)).toThrow(/by name/);
  });
  // The route side counts a call only: a route importing hiddenPower for a type, or naming it in a comment or a
  // string, does not give the planted action a route.
  const plantedAction = `"use server";\nimport { hiddenPower } from "@/server/dal";\nexport async function go() { hiddenPower(1); }`;
  const withRoute = (text: string) => withoutRoute([...actions, ["src/app/x/actions.ts", plantedAction]], [...routes, ["src/app/api/x/route.ts", text]]);
  it("known-bad: a route importing the function only for a type gives it no route", () => {
    expect(withRoute(`import { hiddenPower } from "@/server/dal";\ntype Out = ReturnType<typeof hiddenPower>;\nexport async function POST(): Promise<Out | null> { return null; }`)).toEqual(["hiddenPower"]);
  });
  it("known-bad: ... nor one naming it only in a comment or a string", () => {
    expect(withRoute(`import { hiddenPower } from "@/server/dal";\n// hiddenPower(1) is what the action does\nexport async function POST() { return new Response("hiddenPower(1)"); }`)).toEqual(["hiddenPower"]);
  });
  it("a route calling the function, awaited or under an alias, gives it its route (positive control)", () => {
    expect(withRoute(`import { hiddenPower } from "@/server/dal";\nexport async function POST() { return Response.json(await hiddenPower(1)); }`)).toEqual([]);
    expect(withRoute(`import { hiddenPower as power } from "@/server/dal";\nexport async function POST() { power(1); return new Response(null); }`)).toEqual([]);
  });
  it("an imported type, or a name only in the import, is no use (positive control)", () => {
    expect([...dalUses(`import { type Actor, currentActor, unused } from "@/server/dal";\nconst a: Actor | null = await currentActor();`)]).toEqual(["currentActor"]);
    expect([...dalUses(`import type { Actor } from "@/server/dal";\nlet a: Actor;`)]).toEqual([]);
  });
});
