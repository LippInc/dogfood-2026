import { NextResponse, type NextRequest } from "next/server";
import { crossOriginWrite } from "@/lib/cross-site";
import { PAGE_PATH_HEADER } from "@/lib/page-mark";

/**
 * A write to the API from a page of another origin arrives without its cookies (src/lib/cross-site.ts).
 * A page request carries its own path in a header, which the page's mark is drawn from
 * (src/lib/page-mark.ts): Server Components cannot read the address otherwise.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    if (!request.headers.has("cookie") || !crossOriginWrite(request.method, request.headers)) return NextResponse.next();
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    return NextResponse.next({ request: { headers } });
  }
  const headers = new Headers(request.headers);
  headers.set(PAGE_PATH_HEADER, pathname);
  return NextResponse.next({ request: { headers } });
}

// The API, and every page; not Next's own files or anything with a file extension.
export const config = { matcher: ["/api/:path*", "/((?!api/|_next/|.*\\.).*)"] };
