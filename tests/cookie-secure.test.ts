import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secureCookies } from "@/server/settings";

// Cookies are Secure when COOKIE_SECURE says so, and otherwise when PUBLIC_URL is https://,
// so an HTTPS deployment that forgets COOKIE_SECURE still keeps the session cookie off plain
// http; the offline run on http://localhost:8080 (which run.py uses) stays plain.

const set = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({ set, get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));
const { setSessionCookie } = await import("@/server/session");

const saved = { url: process.env.PUBLIC_URL, flag: process.env.COOKIE_SECURE };
afterEach(() => {
  for (const [k, v] of [["PUBLIC_URL", saved.url], ["COOKIE_SECURE", saved.flag]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  set.mockClear();
});

describe("secureCookies", () => {
  it("follows PUBLIC_URL when COOKIE_SECURE is unset, and COOKIE_SECURE overrides either way", () => {
    expect(secureCookies({ PUBLIC_URL: "https://hack.example.org" })).toBe(true);
    expect(secureCookies({ PUBLIC_URL: "HTTPS://hack.example.org/" })).toBe(true);
    expect(secureCookies({ PUBLIC_URL: "http://localhost:8080" })).toBe(false);
    expect(secureCookies({})).toBe(false);
    expect(secureCookies({ PUBLIC_URL: "https://hack.example.org", COOKIE_SECURE: "false" })).toBe(false);
    expect(secureCookies({ PUBLIC_URL: "http://localhost:8080", COOKIE_SECURE: "true" })).toBe(true);
    expect(secureCookies({ PUBLIC_URL: "https://hack.example.org", COOKIE_SECURE: "" })).toBe(true);
  });

  it("the session cookie is Secure on an https PUBLIC_URL without COOKIE_SECURE, and plain on the offline localhost run", async () => {
    delete process.env.COOKIE_SECURE;
    process.env.PUBLIC_URL = "https://hack.example.org";
    await setSessionCookie("tok", new Date("2030-01-01T00:00:00Z"));
    expect(set.mock.calls.at(-1)![2]).toMatchObject({ secure: true, httpOnly: true });

    process.env.PUBLIC_URL = "http://localhost:8080";
    await setSessionCookie("tok", new Date("2030-01-01T00:00:00Z"));
    expect(set.mock.calls.at(-1)![2]).toMatchObject({ secure: false, httpOnly: true });
  });

  it("every cookie the portal sets on the server takes Secure from secureCookies, not COOKIE_SECURE alone", () => {
    const files = ["src/server/session.ts", "src/app/api/vote/[code]/route.ts", "src/app/vote/[code]/actions.ts"];
    for (const f of files) {
      const text = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      expect(text, f).toContain("secure: secureCookies()");
      expect(text, f).not.toContain("process.env.COOKIE_SECURE");
    }
  });
});
