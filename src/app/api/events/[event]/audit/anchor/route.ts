import { checkSavedHead, currentActor, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * GET /api/events/[event]/audit/anchor?entry=412&hash=...: whether the log still holds a head you saved (row #entry
 * with this hash), as `{ entry, hash, holds }`. Nothing else about the log. Organizers only.
 */
export async function GET(req: Request, { params }: RouteContext<"/api/events/[event]/audit/anchor">) {
  const q = new URL(req.url).searchParams;
  return route(async () => json(checkSavedHead(await currentActor(), (await params).event, { entry: q.get("entry") ?? "", hash: q.get("hash") ?? "" })));
}
