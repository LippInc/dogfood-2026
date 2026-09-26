import { currentActor, json, mergeDuplicate, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/duplicates/merge { keepId, duplicateId }: two same-titled copies become one project; both stay in the raw table. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/duplicates/merge">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(mergeDuplicate(await currentActor(), (await params).event, body ?? {}));
  });
}
