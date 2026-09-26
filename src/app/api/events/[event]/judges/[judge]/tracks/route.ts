import { currentActor, json, route, setJudgeTracks } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/judges/[judge]/tracks { trackIds: [] }: set a judge's tracks; existing assignments stay. Organizers only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/judges/[judge]/tracks">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, judge } = await params;
    return json(setJudgeTracks(await currentActor(), event, judge, body ?? {}));
  });
}
