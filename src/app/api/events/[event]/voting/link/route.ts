import { currentActor, json, makeVotingLink, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: a new open voting link (the old one stops working). The code is returned once. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/voting/link">) {
  return route(async () => json(makeVotingLink(await currentActor(), (await params).event), 201));
}
