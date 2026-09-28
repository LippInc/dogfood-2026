import { currentActor, json, removeJudge, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/judges/[judge]/remove { reason }: remove a judge from the event; what they saved stays on record, out of the ranking. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/judges/[judge]/remove">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, judge } = await params;
    return json(removeJudge(await currentActor(), event, judge, body ?? {}));
  });
}
