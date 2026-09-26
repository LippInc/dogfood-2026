import { createTeam, currentActor, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/teams { name }: create a team and become its captain, while submissions are open. Any signed-in person not yet on a team in the event. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/teams">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(createTeam(await currentActor(), (await params).event, body ?? {}), 201);
  });
}
