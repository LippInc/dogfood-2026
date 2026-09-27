import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { crossOriginWrite } from "@/lib/cross-site";

// A write to the API sent by a page of another origin must not carry the visitor's
// session; everything else (the checker, curl, the portal's own pages, GETs, Bearer
// tokens) passes as it is.

const h = (init: Record<string, string>) => new Headers({ host: "localhost:8080", ...init });

describe("crossOriginWrite", () => {
  it("flags writes a browser marks as coming from another origin", () => {
    expect(crossOriginWrite("POST", h({ "sec-fetch-site": "same-site" }))).toBe(true);
    expect(crossOriginWrite("POST", h({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(crossOriginWrite("PUT", h({ "sec-fetch-site": "same-site" }))).toBe(true);
    expect(crossOriginWrite("DELETE", h({ "sec-fetch-site": "cross-site" }))).toBe(true);
  });

  it("falls back to Origin when a browser sends no Sec-Fetch-Site", () => {
    expect(crossOriginWrite("POST", h({ origin: "http://localhost:3001" }))).toBe(true);
    expect(crossOriginWrite("POST", h({ origin: "null" }))).toBe(true);
    expect(crossOriginWrite("POST", h({ origin: "not a url" }))).toBe(true);
    expect(crossOriginWrite("POST", h({ origin: "http://localhost:8080" }))).toBe(false);
    expect(crossOriginWrite("POST", h({ origin: "https://portal.example.org", "x-forwarded-host": "portal.example.org" }))).toBe(false);
  });

  it("positive controls: the portal's own pages, safe methods and non-browser clients pass", () => {
    expect(crossOriginWrite("POST", h({ "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(crossOriginWrite("POST", h({ "sec-fetch-site": "none" }))).toBe(false);
    expect(crossOriginWrite("GET", h({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(crossOriginWrite("HEAD", h({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(crossOriginWrite("POST", h({}))).toBe(false); // curl, scripts, run.py
  });
});

describe("proxy", () => {
  const request = (headers: Record<string, string>, method = "POST") =>
    new NextRequest("http://localhost:8080/api/events", { method, headers: { host: "localhost:8080", ...headers } });
  // NextResponse.next({ request: { headers } }) lists the headers the route will see.
  const forwarded = (res: Response) => res.headers.get("x-middleware-override-headers");

  it("drops the cookies from a cross-origin write, and only the cookies", () => {
    const res = proxy(request({ cookie: "session=abc", "sec-fetch-site": "same-site", authorization: "Bearer t" }));
    const seen = forwarded(res)?.split(",") ?? [];
    expect(seen).not.toContain("cookie");
    expect(seen).toContain("authorization");
  });

  it("positive controls: same-origin writes, reads and cookie-less requests go through untouched", () => {
    expect(forwarded(proxy(request({ cookie: "session=abc", "sec-fetch-site": "same-origin" })))).toBeNull();
    expect(forwarded(proxy(request({ cookie: "session=abc", "sec-fetch-site": "cross-site" }, "GET")))).toBeNull();
    expect(forwarded(proxy(request({ cookie: "session=abc" })))).toBeNull();
    expect(forwarded(proxy(request({ "sec-fetch-site": "cross-site" })))).toBeNull();
  });
});
