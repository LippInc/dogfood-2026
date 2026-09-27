// Whether a request to the API is a browser write sent by a page of another origin.
//
// SameSite=Lax keeps the session cookie off requests from other sites, but not off
// requests from the same site on another origin: another app on localhost, or a
// sibling subdomain in production. The API reads JSON whatever the Content-Type, so
// such a page could send a text/plain POST, which needs no CORS preflight, and act
// with the visitor's session. src/proxy.ts therefore drops the cookies from those
// writes: they arrive signed out and the data access layer answers them like any
// anonymous call. Requests with neither Sec-Fetch-Site nor Origin (curl, scripts,
// the checker) are not from a browser and pass as they are; a Bearer token is never
// attached by a browser on its own, so it is left alone.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function crossOriginWrite(method: string, headers: Headers): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const site = headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  // Browsers without Sec-Fetch-Site still send Origin on a cross-origin write.
  const origin = headers.get("origin");
  if (!origin) return false;
  if (origin === "null") return true;
  // a chain of proxies lists hosts left to right; the first is the one the browser used
  const host = (headers.get("x-forwarded-host") ?? headers.get("host"))?.split(",")[0]!.trim();
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}
