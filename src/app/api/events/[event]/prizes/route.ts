import { currentActor, json, route, savePrizes } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/prizes <rows array>: replace the event's prizes. Organizers only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/prizes">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(savePrizes(await currentActor(), (await params).event, body ?? {}));
  });
}
