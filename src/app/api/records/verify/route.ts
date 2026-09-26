import { json, route, verifyRecord } from "@/server/dal";

export const dynamic = "force-dynamic";

const OPEN = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };

/** POST { record, signature }: check a record against this portal's published keys. Public, from any site. */
export async function POST(req: Request) {
  return route(async () => json(verifyRecord(await req.json().catch(() => null)), 200, OPEN));
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: OPEN });
}
