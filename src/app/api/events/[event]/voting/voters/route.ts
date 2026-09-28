import { addListedVoters, currentActor, json, mailVoterLinks, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST { emails }: add people to the voter list; each personal link is returned once, and mailed to its person when email is on. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/voting/voters">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const actor = await currentActor();
    const { event } = await params;
    const added = addListedVoters(actor, event, body ?? {});
    return json({ ...added, mail: await mailVoterLinks(actor, event, added.links) }, 201);
  });
}
