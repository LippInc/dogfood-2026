import { currentActor, inviteJudges, json, mailJudgeInvites, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * POST /api/events/[event]/judges/invites/batch { lines, trackIds }: invite many judges from a pasted list, one link
 * each, returned once (and mailed to each address when email is on). Organizers only.
 */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/judges/invites/batch">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event } = await params;
    const actor = await currentActor();
    const made = inviteJudges(actor, event, body ?? {});
    const mail = await mailJudgeInvites(actor, event, made.invites);
    return json({ ...made, mail }, 201);
  });
}
