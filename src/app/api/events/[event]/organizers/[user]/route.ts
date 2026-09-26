import { currentActor, json, removeOrganizer, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** DELETE /api/events/[event]/organizers/[user]: remove an organizer; the last one stays (409). Organizers only. */
export async function DELETE(_req: Request, { params }: RouteContext<"/api/events/[event]/organizers/[user]">) {
  return route(async () => {
    const { event, user } = await params;
    return json(removeOrganizer(await currentActor(), event, user));
  });
}
