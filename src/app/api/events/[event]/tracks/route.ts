import { currentActor, json, route, saveTracks } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/tracks <rows array>: replace the event's tracks. Organizers only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/tracks">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(saveTracks(await currentActor(), (await params).event, body ?? {}));
  });
}
