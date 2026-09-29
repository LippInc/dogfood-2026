import { json, signOut } from "@/server/dal";

/** A browser's own form post, which expects a page back, rather than an API client, which expects JSON. */
function fromAPage(req: Request): boolean {
  return req.headers.get("sec-fetch-mode") === "navigate" || (req.headers.get("accept") ?? "").includes("text/html");
}

/**
 * Ends the login session the request carries, by cookie or Authorization: Bearer (checker sessions are never
 * ended). An API client gets 200 { signedOut }: false, with a reason, while what it sent still works (an API
 * token, which sign-out does not revoke, or a checker session). The interface's sign-out button, a form post, is
 * sent home. That address is relative: in the container the request URL reads http://0.0.0.0:8080, which no
 * browser can open, so a redirect built from it stranded everyone who signed out.
 */
export async function POST(req: Request) {
  const result = await signOut();
  if (fromAPage(req)) return new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store" } });
  return json(result);
}
