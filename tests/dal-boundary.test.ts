import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The architecture rule this file guards (CLAUDE.md, "Architecture rules"):
// one data access layer. No file outside src/server/ may import drizzle-orm,
// better-sqlite3, or any server module other than @/server/dal and
// @/server/boot — including via relative paths that resolve into src/server.

type SourceFile = { path: string; text: string };
type Violation = { file: string; specifier: string; reason: string };

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const SERVER_DIR = path.join(ROOT, "src", "server");

const toPosix = (p: string) => p.split(path.sep).join("/");

const insideServer = (abs: string): boolean => {
  const a = abs.toLowerCase();
  const s = SERVER_DIR.toLowerCase();
  return a === s || a.startsWith(s + path.sep);
};

// import ... from "x" / export ... from "x" / import("x") / require("x") / bare import "x"
const SPECIFIER_PATTERNS: RegExp[] = [
  /\bimport\s+[^;'"()]*?\bfrom\s*["']([^"']+)["']/g,
  /\bexport\s+[^;'"()]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /^[ \t]*import\s*["']([^"']+)["']/gm,
];

function specifiersOf(text: string): string[] {
  const found: string[] = [];
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) if (m[1]) found.push(m[1]);
  }
  return found;
}

function violationFor(file: string, spec: string): Violation | null {
  if (spec === "drizzle-orm" || spec.startsWith("drizzle-orm/")) {
    return { file, specifier: spec, reason: "imports drizzle-orm outside the data access layer" };
  }
  if (spec === "better-sqlite3" || spec.startsWith("better-sqlite3/")) {
    return { file, specifier: spec, reason: "imports better-sqlite3 outside the data access layer" };
  }
  if (spec === "@/server" || spec.startsWith("@/server/")) {
    const allowed =
      spec === "@/server/dal" ||
      spec === "@/server/boot" ||
      spec.startsWith("@/server/dal/") ||
      spec.startsWith("@/server/boot/");
    if (!allowed) {
      return { file, specifier: spec, reason: "imports a server module other than @/server/dal or @/server/boot" };
    }
    return null;
  }
  if (spec.startsWith(".")) {
    const target = path
      .resolve(path.dirname(path.join(ROOT, file)), spec)
      .toLowerCase()
      .replace(/\.(ts|tsx)$/, "");
    const server = SERVER_DIR.toLowerCase();
    const entersServer = target === server || target.startsWith(server + path.sep);
    if (!entersServer) return null;
    // The one sanctioned bridge: Next's instrumentation hook starts the boot.
    if (toPosix(file) === "src/instrumentation.ts" && target === path.join(server, "boot")) return null;
    return { file, specifier: spec, reason: "reaches into src/server with a relative import" };
  }
  return null;
}

function checkBoundary(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const f of files) {
    if (insideServer(path.join(ROOT, f.path))) continue;
    for (const spec of specifiersOf(f.text)) {
      const v = violationFor(f.path, spec);
      if (v) violations.push(v);
    }
  }
  return violations;
}

// src/server/db/schema.ts is the one file allowed to skip the guard: the repo
// root's drizzle.config.ts imports it to generate migrations, outside any
// server bundle.
const SERVER_ONLY_EXCEPTIONS = new Set(["src/server/db/schema.ts"]);

function missingServerOnly(files: SourceFile[]): string[] {
  return files
    .filter((f) => f.path.endsWith(".ts"))
    .filter((f) => insideServer(path.join(ROOT, f.path)))
    .filter((f) => !SERVER_ONLY_EXCEPTIONS.has(toPosix(f.path)))
    .filter((f) => !/^[ \t]*import\s*["']server-only["']/m.test(f.text))
    .map((f) => f.path);
}

function readSourceTree(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of fs.readdirSync(SRC, { recursive: true })) {
    const rel = toPosix(String(entry));
    if (!/\.(ts|tsx)$/.test(rel)) continue;
    const abs = path.join(SRC, rel);
    if (!fs.statSync(abs).isFile()) continue;
    files.push({ path: `src/${rel}`, text: fs.readFileSync(abs, "utf8") });
  }
  return files;
}

describe("the one data access layer (architecture boundary)", () => {
  it("no file outside src/server/ imports drizzle-orm, better-sqlite3 or a server module besides @/server/dal and @/server/boot", () => {
    const violations = checkBoundary(readSourceTree());
    expect(
      violations,
      violations.map((v) => `${v.file} imports "${v.specifier}" (${v.reason})`).join("\n"),
    ).toEqual([]);
  });

  it("known-bad: the checker flags a direct db import, drizzle-orm and better-sqlite3 outside the layer", () => {
    const violations = checkBoundary([
      { path: "src/app/x/page.tsx", text: 'import { getDb } from "@/server/db/client";\n' },
      { path: "src/components/y.tsx", text: 'import { eq } from "drizzle-orm";\n' },
      { path: "src/app/z/route.ts", text: 'import Database from "better-sqlite3";\n' },
    ]);
    expect(violations).toHaveLength(3);
    expect(violations.map((v) => `${v.file}: ${v.specifier}`)).toEqual([
      "src/app/x/page.tsx: @/server/db/client",
      "src/components/y.tsx: drizzle-orm",
      "src/app/z/route.ts: better-sqlite3",
    ]);
  });

  it("known-bad: a relative import that resolves into src/server is flagged too", () => {
    const violations = checkBoundary([
      { path: "src/lib/db.ts", text: 'const { getDb } = await import("../server/db/client");\n' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe("../server/db/client");
  });

  it("the DAL barrel and the instrumentation boot import stay allowed", () => {
    expect(
      checkBoundary([
        { path: "src/app/ok/page.tsx", text: 'import { getGallery } from "@/server/dal";\n' },
        {
          path: "src/instrumentation.ts",
          text: 'export async function register() {\n  const { bootOrExit } = await import("./server/boot");\n}\n',
        },
      ]),
    ).toEqual([]);
  });

  it("every .ts file under src/server/ opens with import \"server-only\" (schema.ts excepted: drizzle.config.ts reads it)", () => {
    const missing = missingServerOnly(readSourceTree());
    expect(missing, `missing import "server-only": ${missing.join(", ")}`).toEqual([]);
  });

  it("known-bad: a server file without the server-only import is flagged", () => {
    expect(
      missingServerOnly([
        { path: "src/server/leaky.ts", text: 'import { x } from "./other";\n' },
        { path: "src/server/db/schema.ts", text: "export const t = 1;\n" },
        { path: "src/app/ok/page.tsx", text: "export default function P() {\n  return null;\n}\n" },
      ]),
    ).toEqual(["src/server/leaky.ts"]);
  });
});
