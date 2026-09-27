import { currentActor, getPortalEntries, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/audit?limit=500: the portal's own log (rows no event owns: accounts, sign-ins, API tokens, the signing key, demo mode), newest first. Administrators only. */
export async function GET(req: Request) {
  const limit = Math.min(5000, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 500));
  return route(async () => json(getPortalEntries(await currentActor(), { limit })));
}
