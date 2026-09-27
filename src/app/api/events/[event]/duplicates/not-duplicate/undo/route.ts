import { currentActor, json, route, undoNotDuplicate } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/duplicates/not-duplicate/undo { ids: [] }: undo a "different projects" ruling; the copies are flagged again. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/duplicates/not-duplicate/undo">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(undoNotDuplicate(await currentActor(), (await params).event, body ?? {}));
  });
}
