import { currentActor, json, removeAssignment, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/assignments/[assignment]/remove { reason }: take back an assignment nobody has started. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/assignments/[assignment]/remove">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, assignment } = await params;
    return json(removeAssignment(await currentActor(), event, assignment, body ?? {}));
  });
}
