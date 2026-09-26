import { currentActor, json, revokeJudgeInvite, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/judges/invites/[invite]/revoke: revoke an open invitation. Organizers only. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/judges/invites/[invite]/revoke">) {
  return route(async () => json(revokeJudgeInvite(await currentActor(), (await params).invite)));
}
