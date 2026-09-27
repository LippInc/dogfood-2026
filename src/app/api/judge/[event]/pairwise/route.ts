import { currentActor, getPairwiseState, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/judge/[event]/pairwise: the judge's own lists and the question to answer next, per track. The event's judges only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/judge/[event]/pairwise">) {
  return route(async () => json(getPairwiseState(await currentActor(), (await params).event)));
}
