import { getCommunityResults, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: the community vote. While voting is open the tally is null for everyone, organizers included. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/community">) {
  return route(async () => json(getCommunityResults((await params).event)));
}
