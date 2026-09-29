import { currentActor, getPrizeAwards, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/awards: every prize and who won it. Organizers before publishing; public once the results are. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/awards">) {
  return route(async () => json(getPrizeAwards(await currentActor(), (await params).event)));
}
