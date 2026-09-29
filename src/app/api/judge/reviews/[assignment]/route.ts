import { currentActor, json, route, samePagePerson, saveReview } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * PUT /api/judge/reviews/<assignment>  { values: { <criterion key>: 1..5 | null }, feedback?, privateNote? }
 * Saves the signed-in judge's review of one of their own assignments. Another
 * judge's assignment is 403, a closed judging window 403, no session 401.
 */
export async function PUT(req: Request, ctx: RouteContext<"/api/judge/reviews/[assignment]">) {
  return route(async () => {
    await samePagePerson();
    const { assignment } = await ctx.params;
    const actor = await currentActor();
    const body = await req.json().catch(() => null);
    return json(saveReview(actor, assignment, body ?? {}));
  });
}
