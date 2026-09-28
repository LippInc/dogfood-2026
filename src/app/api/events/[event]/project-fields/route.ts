import { currentActor, getProjectFields, json, route, saveProjectFields } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/project-fields: what teams fill in, each built-in field required, optional or hidden. Public. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/project-fields">) {
  return route(async () => json(getProjectFields((await params).event)));
}

/** PUT /api/events/[event]/project-fields { title?: "required" | "optional" | "hidden", ... }: choose what teams fill in. Organizers only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/project-fields">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(saveProjectFields(await currentActor(), (await params).event, body));
  });
}
