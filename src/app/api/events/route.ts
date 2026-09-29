import { createEvent, currentActor, json, listEvents, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events: every event's public facts. Public. */
export async function GET(_req: Request) {
  return route(async () => json({ events: listEvents() }));
}

/**
 * POST /api/events { slug?, details: { name, description, ... }, tracks: [], prizes: [], sourceEventId? }: create an event and
 * become its organizer, blank or from the settings of an event the caller organizes. Portal administrators only.
 */
export async function POST(req: Request) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(createEvent(await currentActor(), body ?? {}), 201);
  });
}
