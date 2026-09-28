import { currentActor, json, organizerRemoveMember, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST { reason }: an organizer takes someone off the team, until results are published. */
export async function POST(req: Request, { params }: RouteContext<"/api/teams/[team]/members/[user]/remove">) {
  return route(async () => {
    const { team, user } = await params;
    const body: unknown = await req.json().catch(() => null);
    return json(organizerRemoveMember(await currentActor(), team, user, body ?? {}));
  });
}
