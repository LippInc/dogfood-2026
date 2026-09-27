import { currentActor, json, route, setJudgingMode } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/judging-mode  { mode: "scores" | "pairwise", reason }: how the judges judge; 409 once results are published. Organizers only. */
export async function PUT(req: Request, ctx: RouteContext<"/api/events/[event]/judging-mode">) {
  return route(async () => {
    const { event } = await ctx.params;
    const actor = await currentActor();
    const body = await req.json().catch(() => null);
    return json(setJudgingMode(actor, event, body ?? {}));
  });
}
