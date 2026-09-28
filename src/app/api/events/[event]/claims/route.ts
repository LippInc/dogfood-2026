import { currentActor, json, mailClaimLinks, makeClaimLinks, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: a fresh personal link for everyone in the event who has no password yet; returned this once, and mailed to each when email is on. Organizers only. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/claims">) {
  return route(async () => {
    const actor = await currentActor();
    const { event } = await params;
    const made = makeClaimLinks(actor, event);
    return json({ ...made, mail: await mailClaimLinks(actor, event, made.links) }, 201);
  });
}
