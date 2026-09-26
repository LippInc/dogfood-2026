import { NextResponse } from "next/server";
import { signOut } from "@/server/dal";

/** Ends this browser's login session (checker sessions are never touched) and goes home. */
export async function POST(req: Request) {
  await signOut();
  return NextResponse.redirect(new URL("/", req.url), 303);
}
