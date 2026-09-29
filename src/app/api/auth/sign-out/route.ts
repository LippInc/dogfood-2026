import { json, signOut } from "@/server/dal";

/** A browser's own form post, which expects a page back, rather than an API client, which expects JSON. */
function fromAPage(req: Request): boolean {
  return req.headers.get("sec-fetch-mode") === "navigate" || (req.headers.get("accept") ?? "").includes("text/html");
}

/**
 * Ends this browser's login session (checker sessions are never touched). An API client gets
 * 200 { signedOut: true }; the interface's sign-out button, a form post, is sent home. That address
 * is relative: in the container the request URL reads http://0.0.0.0:8080, which no browser can
 * open, so a redirect built from it stranded everyone who signed out.
 */
export async function POST(req: Request) {
  await signOut();
  if (fromAPage(req)) return new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store" } });
  return json({ signedOut: true });
}
