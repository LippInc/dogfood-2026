import { currentActor, json, route, unmergeDuplicate } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/duplicates/unmerge { duplicateId }: undo a merge; both copies count as projects again. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/duplicates/unmerge">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(unmergeDuplicate(await currentActor(), (await params).event, body ?? {}));
  });
}
