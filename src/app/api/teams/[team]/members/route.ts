import { currentActor, json, organizerAddMember, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST { email, reason }: an organizer puts someone with an account on the team, until results are published. */
export async function POST(req: Request, { params }: RouteContext<"/api/teams/[team]/members">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(organizerAddMember(await currentActor(), (await params).team, body ?? {}), 201);
  });
}
