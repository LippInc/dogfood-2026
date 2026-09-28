import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";

// In the container the server listens on 0.0.0.0:8080, so the URL a route handler is handed reads
// http://0.0.0.0:8080/...; a redirect built from it sent every browser that signed out to an address
// it cannot open (ERR_ADDRESS_INVALID), whatever address the browser had used. Sign-out answers
// with a relative Location, which the browser resolves against the address it is on.
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

describe("POST /api/auth/sign-out", () => {
  it("clears the session cookie and goes home by a relative address, whatever host the server listens on", async () => {
    for (const url of ["http://0.0.0.0:8080/api/auth/sign-out", "http://localhost:8080/api/auth/sign-out"]) {
      const res = await POST(new Request(url, { method: "POST" }));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    }
    expect(cookieDelete).toHaveBeenCalledWith("session");
  });
});
