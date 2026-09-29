import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";

// In the container the server listens on 0.0.0.0:8080, so the URL a route handler is handed reads
// http://0.0.0.0:8080/...; a redirect built from it sent every browser that signed out to an address
// it cannot open (ERR_ADDRESS_INVALID), whatever address the browser had used. Sign-out answers a
// browser's form post with a relative Location, which the browser resolves against the address it is
// on, and an API client with JSON: the API reference promises JSON answers, not redirects.
const cookieDelete = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(() => undefined), delete: cookieDelete }),
  headers: async () => new Headers(),
}));

const { POST } = await import("@/app/api/auth/sign-out/route");

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  setHandleForTests(h);
  cookieDelete.mockClear();
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

const PAGE = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "sec-fetch-mode": "navigate" };

describe("POST /api/auth/sign-out", () => {
  it("a browser's form post clears the session cookie and goes home by a relative address, whatever host the server listens on", async () => {
    for (const url of ["http://0.0.0.0:8080/api/auth/sign-out", "http://localhost:8080/api/auth/sign-out"]) {
      const res = await POST(new Request(url, { method: "POST", headers: PAGE }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    }
    // an older browser without Sec-Fetch-Mode still asks for HTML
    const old = await POST(new Request("http://localhost:8080/api/auth/sign-out", { method: "POST", headers: { accept: PAGE.accept } }));
    expect(old.status).toBe(303);
    expect(cookieDelete).toHaveBeenCalledWith("session");
  });

  it("an API client (curl, fetch) gets 200 JSON, never a redirect, and the cookie is cleared the same way", async () => {
    const clients: Record<string, string>[] = [{}, { accept: "*/*" }, { accept: "application/json" }, { "sec-fetch-mode": "cors", accept: "*/*" }];
    for (const headers of clients) {
      cookieDelete.mockClear();
      const res = await POST(new Request("http://localhost:8080/api/auth/sign-out", { method: "POST", headers }));
      expect(res.status, JSON.stringify(headers)).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toEqual({ signedOut: true });
      expect(cookieDelete).toHaveBeenCalledWith("session");
    }
  });
});
