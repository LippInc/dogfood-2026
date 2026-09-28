import { currentActor, json, route, takeDownProjectImage } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST { reason }: an organizer takes a project's picture down, uploaded or linked, at any time; the reason goes into the audit log. */
export async function POST(req: Request, { params }: RouteContext<"/api/projects/[project]/take-down-picture">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(takeDownProjectImage(await currentActor(), (await params).project, body ?? {}));
  });
}
