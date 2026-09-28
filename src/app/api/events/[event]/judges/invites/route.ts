import { currentActor, inviteJudge, json, mailJudgeInvite, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/judges/invites { name?, email?, trackIds: [] }: make a judge invitation link; it is shown only once, and mailed to the email when one is given and email is on. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/judges/invites">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const actor = await currentActor();
    const { event } = await params;
    const invite = inviteJudge(actor, event, body ?? {});
    return json({ ...invite, mail: await mailJudgeInvite(actor, event, invite) }, 201);
  });
}
