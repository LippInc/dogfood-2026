import { addFinalist, currentActor, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/finals/[finals]/finalists { project, reason? }: add a finalist; a reason when it is not in its track's top N. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/finals/[finals]/finalists">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, finals } = await params;
    return json(addFinalist(await currentActor(), event, finals, body ?? {}));
  });
}
