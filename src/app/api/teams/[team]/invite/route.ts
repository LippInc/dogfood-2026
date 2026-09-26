import { currentActor, json, rotateInvite, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/teams/[team]/invite: make a fresh invite code; every older link stops working. The team's captain. */
export async function POST(_req: Request, { params }: RouteContext<"/api/teams/[team]/invite">) {
  return route(async () => json(rotateInvite(await currentActor(), (await params).team)));
}
