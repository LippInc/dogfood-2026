import { currentActor, json, pickPairwise, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/judge/[event]/pairwise/pick  { trackId, left, right, outcome }: answer the current question; 409 if it is not the current one. */
export async function POST(req: Request, ctx: RouteContext<"/api/judge/[event]/pairwise/pick">) {
  return route(async () => {
    const { event } = await ctx.params;
    const actor = await currentActor();
    const body = await req.json().catch(() => null);
    return json(pickPairwise(actor, event, body ?? {}));
  });
}
