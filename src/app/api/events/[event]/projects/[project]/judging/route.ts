import { currentActor, getProjectJudging, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/projects/[project]/judging: the project's track and every judge assigned to it, with what each can be. Organizers only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/projects/[project]/judging">) {
  return route(async () => {
    const { event, project } = await params;
    const { event: _event, ...view } = getProjectJudging(await currentActor(), event, project);
    return json(view);
  });
}
