import { currentActor, json, route, setJudgeRanking } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/judge-ranking  { show }: whether judges see their own ranking so far; 409 once results are published. Organizers only. */
export async function PUT(req: Request, ctx: RouteContext<"/api/events/[event]/judge-ranking">) {
  return route(async () => {
    const { event } = await ctx.params;
    const actor = await currentActor();
    const body = await req.json().catch(() => null);
    return json(setJudgeRanking(actor, event, body ?? {}));
  });
}
