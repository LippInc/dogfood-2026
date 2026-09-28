import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { proxy } from "@/proxy";
import { hstsFor, HSTS_VALUE } from "@/lib/hsts";

// Response headers beyond framing: a Permissions-Policy, a Content-Security-Policy that keeps
// plugins, <base> and form posts at home without touching Next's scripts, and HSTS only when
// the portal lives on https (the offline run on http://localhost:8080 must stay reachable).

const saved = process.env.PUBLIC_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = saved;
});

async function headersFor(path: string): Promise<Map<string, string>> {
  const rules = await nextConfig.headers!();
  const out = new Map<string, string>();
  for (const rule of rules) {
    // the two sources: every path but /embed/..., and /embed/...
    const matches = rule.source.startsWith("/embed/") ? path.startsWith("/embed/") : !path.startsWith("/embed/");
    if (matches) for (const h of rule.headers) out.set(h.key.toLowerCase(), h.value);
  }
  return out;
}

describe("security headers", () => {
  it("pages: framing refused, a policy against plugins, foreign <base> and foreign form posts, and no device permissions", async () => {
    const h = await headersFor("/events/sample-hack-2026");
    const csp = h.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    // never a script or style rule: Next's inline bootstrap scripts would stop running
    expect(csp).not.toMatch(/script-src|default-src|style-src|upgrade-insecure-requests/);
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("permissions-policy")).toContain("camera=()");
    expect(h.get("permissions-policy")).toContain("geolocation=()");
    expect(h.get("permissions-policy")).not.toContain("clipboard"); // the copy buttons need it
  });

  it("the embed stays framable anywhere, with the same other rules", async () => {
    const h = await headersFor("/embed/sample-hack-2026");
    expect(h.get("content-security-policy")).toContain("frame-ancestors * file:");
    expect(h.get("content-security-policy")).toContain("object-src 'none'");
    expect(h.has("x-frame-options")).toBe(false);
    expect(h.get("permissions-policy")).toContain("microphone=()");
  });

  it("HSTS only on an https PUBLIC_URL, on pages and API answers alike; none on the offline http run", () => {
    expect(hstsFor("https://hack.example.org")).toBe(HSTS_VALUE);
    expect(hstsFor("http://localhost:8080")).toBeNull();
    expect(hstsFor(undefined)).toBeNull();

    process.env.PUBLIC_URL = "https://hack.example.org";
    expect(proxy(new NextRequest("https://hack.example.org/events/x")).headers.get("strict-transport-security")).toBe(HSTS_VALUE);
    expect(proxy(new NextRequest("https://hack.example.org/api/events")).headers.get("strict-transport-security")).toBe(HSTS_VALUE);
    const refused = proxy(new NextRequest("https://hack.example.org/api/auth/sign-in", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("strict-transport-security")).toBe(HSTS_VALUE);

    process.env.PUBLIC_URL = "http://localhost:8080";
    expect(proxy(new NextRequest("http://localhost:8080/events/x")).headers.get("strict-transport-security")).toBeNull();
    delete process.env.PUBLIC_URL;
    expect(proxy(new NextRequest("http://localhost:8080/api/events")).headers.get("strict-transport-security")).toBeNull();
  });
});
