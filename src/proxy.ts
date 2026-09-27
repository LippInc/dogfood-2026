import { NextResponse, type NextRequest } from "next/server";
import { crossOriginWrite } from "@/lib/cross-site";

/** A write to the API from a page of another origin arrives without its cookies (src/lib/cross-site.ts). */
export function proxy(request: NextRequest) {
  if (!request.headers.has("cookie") || !crossOriginWrite(request.method, request.headers)) return NextResponse.next();
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: "/api/:path*" };
