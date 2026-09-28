import { currentActor, json, listOutbox, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: the last 100 messages mailed for the event (or kept while email is off), newest first. Organizers only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/outbox">) {
  return route(async () => json({ outbox: listOutbox(await currentActor(), (await params).event) }));
}
