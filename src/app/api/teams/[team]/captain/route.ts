import { currentActor, json, makeCaptain, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/teams/[team]/captain { userId }: hand the captaincy to another member while submissions are open. The team's captain. */
export async function PUT(req: Request, { params }: RouteContext<"/api/teams/[team]/captain">) {
  return route(async () => json(makeCaptain(await currentActor(), (await params).team, await req.json().catch(() => null))));
}
