import { currentActor, getPanelFinals, json, route, ValidationError } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * GET /api/judge/[event]/finals            the signed-in panelist's finals: the finalists and their own scores
 * GET /api/judge/[event]/finals?judge=<id> the same, but only when <id> is the signed-in panelist; any other id is 403, never a fallback
 */
export async function GET(req: Request, { params }: RouteContext<"/api/judge/[event]/finals">) {
  return route(async () => {
    const asked = new URL(req.url).searchParams.getAll("judge");
    if (asked.length > 1) throw new ValidationError("Ask for one judge id at a time.");
    return json(getPanelFinals(await currentActor(), (await params).event, asked.length === 1 ? asked[0]! : null));
  });
}
