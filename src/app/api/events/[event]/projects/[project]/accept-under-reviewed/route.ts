import { acceptUnderReviewed, currentActor, json, route, undoAcceptUnderReviewed } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/projects/[project]/accept-under-reviewed { reason }: publish the project with the reviews it has, marked. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/projects/[project]/accept-under-reviewed">) {
  return route(async () => {
    const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
    const { event, project } = await params;
    return json(acceptUnderReviewed(await currentActor(), event, { projectId: project, reason: body?.reason ?? "" }));
  });
}

/** DELETE /api/events/[event]/projects/[project]/accept-under-reviewed: undo it; the project is an open decision again. Organizers only. */
export async function DELETE(_req: Request, { params }: RouteContext<"/api/events/[event]/projects/[project]/accept-under-reviewed">) {
  return route(async () => {
    const { event, project } = await params;
    return json(undoAcceptUnderReviewed(await currentActor(), event, { projectId: project }));
  });
}
