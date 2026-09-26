import { addOrganizer, currentActor, json, listOrganizers, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/organizers: the event's organizers. Organizers only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/organizers">) {
  return route(async () => json({ organizers: listOrganizers(await currentActor(), (await params).event) }));
}

/** POST /api/events/[event]/organizers { email }: make an existing account an organizer too; 201 when added, 200 when it already was. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/organizers">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const result = addOrganizer(await currentActor(), (await params).event, body ?? {});
    return json(result, result.added ? 201 : 200);
  });
}
