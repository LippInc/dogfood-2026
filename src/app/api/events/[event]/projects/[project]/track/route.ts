import { currentActor, json, moveProjectTrack, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/projects/[project]/track { trackId, reason }: move the project to another track. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/projects/[project]/track">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, project } = await params;
    return json(moveProjectTrack(await currentActor(), event, project, body ?? {}));
  });
}
