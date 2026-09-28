import { currentActor, json, route, undoRecusal } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/assignments/[assignment]/undo-recusal { reason }: give a recused review back to its judge. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/assignments/[assignment]/undo-recusal">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, assignment } = await params;
    return json(undoRecusal(await currentActor(), event, assignment, body ?? {}));
  });
}
