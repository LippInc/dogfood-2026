import { NextResponse, type NextRequest } from "next/server";
import { crossOriginWrite } from "@/lib/cross-site";
import { hstsFor } from "@/lib/hsts";
import { PAGE_PATH_HEADER } from "@/lib/page-mark";

/**
 * The writes that set a cookie without needing one: signing in or up, setting a password with a personal link or a
 * reset link (each signs the caller in: a session) and entering a voting link (a voter). Dropping the cookies does
 * not stop a page of another origin from sending them, which would sign the visitor in to an account of that page's
 * choosing (login CSRF) or enter voting in the visitor's name, so such writes are refused outright. The portal's own
 * pages, and curl or the checker (no Origin, no Sec-Fetch-Site), are not affected.
 */
const SESSION_STARTERS = new Set(["/api/auth/sign-in", "/api/auth/sign-up", "/api/auth/demo-sign-in"]);
/** A link's token is the last part of these: /api/claims/{token}, /api/password-resets/{token}, /api/vote/{code}. */
const LINK_STARTERS = ["/api/claims/", "/api/password-resets/", "/api/vote/"];
const startsCookie = (pathname: string) => SESSION_STARTERS.has(pathname) || LINK_STARTERS.some((p) => pathname.startsWith(p));

/**
 * A write to the API from a page of another origin arrives without its cookies (src/lib/cross-site.ts), and one
 * that would set a cookie of its own is refused. A page request carries its own path in a header, which the page's mark
 * is drawn from (src/lib/page-mark.ts): Server Components cannot read the address otherwise.
 */
export function proxy(request: NextRequest) {
  return withTransportSecurity(route(request));
}

function route(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    if (startsCookie(pathname) && crossOriginWrite(request.method, request.headers)) {
      return NextResponse.json({ error: "cross_origin", message: "Sign in from this portal's own pages." }, { status: 403 });
    }
    if (!request.headers.has("cookie") || !crossOriginWrite(request.method, request.headers)) return NextResponse.next();
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    return NextResponse.next({ request: { headers } });
  }
  const headers = new Headers(request.headers);
  headers.set(PAGE_PATH_HEADER, pathname);
  return NextResponse.next({ request: { headers } });
}

/** Strict-Transport-Security on every page and API answer, read at request time: only when PUBLIC_URL is https (src/lib/hsts.ts). */
function withTransportSecurity(response: NextResponse): NextResponse {
  const hsts = hstsFor(process.env.PUBLIC_URL);
  if (hsts) response.headers.set("Strict-Transport-Security", hsts);
  return response;
}

// The API, and every page; not Next's own files or anything with a file extension.
export const config = { matcher: ["/api/:path*", "/((?!api/|_next/|.*\\.).*)"] };
