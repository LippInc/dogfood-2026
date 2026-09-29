import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publicUrl } from "@/server/settings";
import { issuer } from "@/server/dal/records";

// The portal's own address comes from one helper: the pages' links and snippets, the API's server URL and the
// signed records' issuer all agree, with or without a trailing slash on PUBLIC_URL.

describe("publicUrl", () => {
  it("is PUBLIC_URL without trailing slashes, or the offline run's address when unset", () => {
    expect(publicUrl({})).toBe("http://localhost:8080");
    expect(publicUrl({ PUBLIC_URL: "https://judging.example.org" })).toBe("https://judging.example.org");
    expect(publicUrl({ PUBLIC_URL: "https://judging.example.org//" })).toBe("https://judging.example.org");
  });

  it("is what the signed records name as their issuer", () => {
    expect(issuer()).toBe(publicUrl());
  });

  it("known-bad guard: no page or route under src/app works the address out on its own", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(process.cwd(), "src", "app"));
    expect(files.length).toBeGreaterThan(50);
    const inline = /process\.env\.PUBLIC_URL\s*\?\?\s*["'`]http/;
    // the pattern finds the copy this guard exists to stop (known-bad), and no file holds one
    expect(inline.test('const origin = process.env.PUBLIC_URL ?? "http://localhost:8080";')).toBe(true);
    expect(files.filter((f) => inline.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });
});
