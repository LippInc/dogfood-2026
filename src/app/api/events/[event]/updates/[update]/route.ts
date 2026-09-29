import { currentActor, editUpdate, json, removeUpdate, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/updates/[update] { title, body }: change an update's words (the audit log keeps the old ones). Organizers only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/updates/[update]">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, update } = await params;
    return json({ update: editUpdate(await currentActor(), event, update, body ?? {}) });
  });
}

/** DELETE /api/events/[event]/updates/[update]: take an update off the event's pages (the audit log keeps its words). Organizers only. */
export async function DELETE(_req: Request, { params }: RouteContext<"/api/events/[event]/updates/[update]">) {
  return route(async () => {
    const { event, update } = await params;
    return json(removeUpdate(await currentActor(), event, update));
  });
}
