import { currentActor, json, route, settleCloseCall, undoCloseCall } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/close-calls/[track] { mode: "keep" } or { mode: "judges", winnerId, reason }: settle a track's close call. Organizers only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/close-calls/[track]">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, track } = await params;
    return json(settleCloseCall(await currentActor(), event, track, body ?? {}));
  });
}

/** DELETE /api/events/[event]/close-calls/[track]: undo the choice before publishing. Organizers only. */
export async function DELETE(_req: Request, { params }: RouteContext<"/api/events/[event]/close-calls/[track]">) {
  return route(async () => {
    const { event, track } = await params;
    return json(undoCloseCall(await currentActor(), event, track));
  });
}
