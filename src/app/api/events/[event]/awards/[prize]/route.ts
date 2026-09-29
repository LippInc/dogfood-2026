import { awardPrize, currentActor, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/awards/[prize] { projectIds, note }: give the prize (jointly with several), or take it back with none. Organizers only, before publishing. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/awards/[prize]">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, prize } = await params;
    return json(awardPrize(await currentActor(), event, prize, body ?? {}));
  });
}
