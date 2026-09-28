import { currentActor, json, renameTeam, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT { name, reason? }: rename the team. Its members while submissions are open; an organizer with a reason until results are published. */
export async function PUT(req: Request, { params }: RouteContext<"/api/teams/[team]/name">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(renameTeam(await currentActor(), (await params).team, body ?? {}));
  });
}
