import { currentActor, json, route, undoPairwise } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/judge/[event]/pairwise/undo  { trackId }: take back the judge's latest answer in that track. */
export async function POST(req: Request, ctx: RouteContext<"/api/judge/[event]/pairwise/undo">) {
  return route(async () => {
    const { event } = await ctx.params;
    const actor = await currentActor();
    const body = await req.json().catch(() => null);
    return json(undoPairwise(actor, event, body ?? {}));
  });
}
