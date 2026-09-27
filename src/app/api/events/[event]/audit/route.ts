import { currentActor, getAuditEntries, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/audit?limit=500: the event's audit log, newest first, as its log page shows it, with the chain's state. Organizers only. */
export async function GET(req: Request, { params }: RouteContext<"/api/events/[event]/audit">) {
  const limit = Math.min(5000, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 500));
  return route(async () => json(getAuditEntries(await currentActor(), (await params).event, { limit })));
}
