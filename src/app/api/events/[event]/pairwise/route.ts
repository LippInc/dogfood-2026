import { currentActor, getPairwiseRanking, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/pairwise: the live pairwise ranking with its receipts, the two pulls and the flags. Organizers only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/pairwise">) {
  return route(async () => json(getPairwiseRanking(await currentActor(), (await params).event)));
}
