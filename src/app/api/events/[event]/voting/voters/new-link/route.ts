import { currentActor, json, mailVoterLinks, newVoterLink, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST { email }: a new personal link for one address already on the voter list; the old one stops working. Returned once, and mailed when email is on. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/voting/voters/new-link">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const actor = await currentActor();
    const { event } = await params;
    const link = newVoterLink(actor, event, body ?? {});
    return json({ ...link, mail: await mailVoterLinks(actor, event, [link]) }, 201);
  });
}
