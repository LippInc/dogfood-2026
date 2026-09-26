import { currentActor, getAssignments, getJudges, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/judges: the judges page's data -- event, tracks, judges, invites and the assignment view. Organizers only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/judges">) {
  return route(async () => {
    const actor = await currentActor();
    const { event } = await params;
    const page = getJudges(actor, event);
    return json({ ...page, assignments: getAssignments(actor, page.event.id) });
  });
}
