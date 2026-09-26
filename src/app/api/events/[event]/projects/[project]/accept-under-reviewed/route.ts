import { acceptUnderReviewed, currentActor, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/projects/[project]/accept-under-reviewed { reason }: publish the project with the reviews it has, marked. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/projects/[project]/accept-under-reviewed">) {
  return route(async () => {
    const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
    const { event, project } = await params;
    return json(acceptUnderReviewed(await currentActor(), event, { projectId: project, reason: body?.reason ?? "" }));
  });
}
