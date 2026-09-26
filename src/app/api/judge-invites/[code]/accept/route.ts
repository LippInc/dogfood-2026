import { acceptJudgeInvite, currentActor, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/judge-invites/[code]/accept: the signed-in person becomes a judge for the invite's tracks. Any signed-in person with the code. */
export async function POST(_req: Request, { params }: RouteContext<"/api/judge-invites/[code]/accept">) {
  return route(async () => json(acceptJudgeInvite(await currentActor(), (await params).code)));
}
