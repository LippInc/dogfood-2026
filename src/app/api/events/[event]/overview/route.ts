import { currentActor, getOverview, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/overview: the organizer overview -- decisions, pipeline, judges, normalization, audit. Organizers only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/overview">) {
  return route(async () => json(getOverview(await currentActor(), (await params).event)));
}
