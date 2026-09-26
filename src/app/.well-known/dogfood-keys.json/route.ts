import { json, keysDocument, route } from "@/server/dal";

export const dynamic = "force-dynamic";

const OPEN = { "access-control-allow-origin": "*" };

/** GET: the public keys that sign this portal's records (Ed25519, JWK). Anyone may fetch them, from any site. */
export async function GET() {
  return route(() => json(keysDocument(), 200, OPEN));
}
