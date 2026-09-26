import { currentActor, json, route, saveRubric } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/rubric <rows array>: replace the scoring rubric; totals are recomputed from the stored scores. Organizers only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/rubric">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(saveRubric(await currentActor(), (await params).event, body ?? {}));
  });
}
