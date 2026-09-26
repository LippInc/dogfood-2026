import { assignByHand, currentActor, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/assignments { projectId, judgeUserId, reason }: give one project a judge by hand. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/assignments">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(assignByHand(await currentActor(), (await params).event, body ?? {}), 201);
  });
}
