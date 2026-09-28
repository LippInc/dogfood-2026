import { signOut } from "@/server/dal";

/**
 * Ends this browser's login session (checker sessions are never touched) and goes home. The
 * address is relative: in the container the request URL reads http://0.0.0.0:8080, which no
 * browser can open, so a redirect built from it stranded everyone who signed out.
 */
export async function POST(_req: Request) {
  await signOut();
  return new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store" } });
}
