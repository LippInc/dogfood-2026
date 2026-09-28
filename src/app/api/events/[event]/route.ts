import { currentActor, getGallery, json, route, updateEventDetails } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]: the event's public facts. Public. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]">) {
  return route(async () => json(getGallery((await params).event).event));
}

/** PUT /api/events/[event] { name, description, submissionsOpenAt, submissionsCloseAt, judgingCloseAt, maxTeamSize, certificatePlaces? }: save the details. Organizers only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(updateEventDetails(await currentActor(), (await params).event, body ?? {}));
  });
}
