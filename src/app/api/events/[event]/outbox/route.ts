import { currentActor, json, listOutbox, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * GET ?before=<id>&limit=<1-500>: the messages mailed for the event (or kept while email is off), newest
 * first, 100 a page by default. `next` is the id to pass as `before` for the older page (null at the end);
 * `counts` are over every message. Organizers only.
 */
export async function GET(req: Request, { params }: RouteContext<"/api/events/[event]/outbox">) {
  return route(async () => {
    const q = new URL(req.url).searchParams;
    const page = listOutbox(await currentActor(), (await params).event, { before: q.get("before"), limit: q.get("limit") });
    return json({ outbox: page.messages, next: page.next, counts: page.counts });
  });
}
