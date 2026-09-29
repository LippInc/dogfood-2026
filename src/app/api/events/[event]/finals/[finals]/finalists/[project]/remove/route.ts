import { currentActor, json, removeFinalist, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/finals/[finals]/finalists/[project]/remove { reason? }: take a finalist off; a reason when it is in its track's top N. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/finals/[finals]/finalists/[project]/remove">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, finals, project } = await params;
    return json(removeFinalist(await currentActor(), event, finals, project, body ?? {}));
  });
}
