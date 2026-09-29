import { currentActor, json, route, setFinalsPanel } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/finals/[finals]/panel { judges: [ids] }: set the panel, at least two of the event's judges. Organizers only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/finals/[finals]/panel">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, finals } = await params;
    return json(setFinalsPanel(await currentActor(), event, finals, body ?? {}));
  });
}
