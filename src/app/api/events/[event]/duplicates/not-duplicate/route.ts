import { currentActor, dismissDuplicate, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/duplicates/not-duplicate { ids: [], reason }: rule that the same-titled copies are different projects. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/duplicates/not-duplicate">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(dismissDuplicate(await currentActor(), (await params).event, body ?? {}));
  });
}
