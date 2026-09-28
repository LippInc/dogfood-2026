import { currentActor, dissolveTeam, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/teams/[team]/dissolve: the team's only member dissolves it while submissions are open; a draft project goes with it, a submitted one keeps the team (409). */
export async function POST(_req: Request, { params }: RouteContext<"/api/teams/[team]/dissolve">) {
  return route(async () => json(dissolveTeam(await currentActor(), (await params).team)));
}
