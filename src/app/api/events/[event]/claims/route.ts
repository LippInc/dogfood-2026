import { currentActor, json, makeClaimLinks, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: a fresh personal link for everyone in the event who has no password yet; returned this once. Organizers only. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/claims">) {
  return route(async () => json(makeClaimLinks(await currentActor(), (await params).event), 201));
}
