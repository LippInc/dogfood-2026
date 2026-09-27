import { currentActor, json, leaveTeam, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/teams/[team]/leave: leave the team while submissions are open. A member; the captain hands over first (409), the last member cannot leave (409). */
export async function POST(_req: Request, { params }: RouteContext<"/api/teams/[team]/leave">) {
  return route(async () => json(leaveTeam(await currentActor(), (await params).team)));
}
