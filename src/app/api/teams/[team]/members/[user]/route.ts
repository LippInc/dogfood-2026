import { currentActor, json, removeMember, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** DELETE /api/teams/[team]/members/[user]: take a member off the team while submissions are open. The team's captain. */
export async function DELETE(_req: Request, { params }: RouteContext<"/api/teams/[team]/members/[user]">) {
  return route(async () => {
    const { team, user } = await params;
    return json(removeMember(await currentActor(), team, user));
  });
}
