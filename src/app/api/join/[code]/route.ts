import { currentActor, joinTeam, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/join/[code]: join the team the code belongs to, while submissions are open and the team is not full. Any signed-in person with the code. */
export async function POST(_req: Request, { params }: RouteContext<"/api/join/[code]">) {
  return route(async () => json(joinTeam(await currentActor(), (await params).code)));
}
