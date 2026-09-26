import { currentActor, getJudgeScores, json, route, ValidationError } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * GET /api/judge/scores            the signed-in judge's own reviews
 * GET /api/judge/scores?judge=<id> the same, but only when <id> is the signed-in
 *                                  judge; any other id is 403, never a fallback
 */
export async function GET(req: Request) {
  return route(async () => {
    const asked = new URL(req.url).searchParams.getAll("judge");
    if (asked.length > 1) throw new ValidationError("Ask for one judge id at a time.");
    const actor = await currentActor();
    return json(getJudgeScores(actor, asked.length === 1 ? asked[0] : null));
  });
}
