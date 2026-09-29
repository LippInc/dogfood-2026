import { currentActor, getFinalsScores, json, route, saveFinalsScore, ValidationError } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * GET /api/judge/[event]/finals/scores            the signed-in panelist's own finals scores
 * GET /api/judge/[event]/finals/scores?judge=<id> the same, but only when <id> is the signed-in panelist; any other id is 403, never a fallback
 */
export async function GET(req: Request, { params }: RouteContext<"/api/judge/[event]/finals/scores">) {
  return route(async () => {
    const asked = new URL(req.url).searchParams.getAll("judge");
    if (asked.length > 1) throw new ValidationError("Ask for one judge id at a time.");
    return json(getFinalsScores(await currentActor(), (await params).event, asked.length === 1 ? asked[0]! : null));
  });
}

/** PUT /api/judge/[event]/finals/scores { finals, project, values }: save the signed-in panelist's score of one finalist. Panelists only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/judge/[event]/finals/scores">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(saveFinalsScore(await currentActor(), (await params).event, body ?? {}));
  });
}
