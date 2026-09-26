import { currentActor, inviteJudge, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/judges/invites { name?, email?, trackIds: [] }: make a judge invitation link; it is shown only once. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/judges/invites">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(inviteJudge(await currentActor(), (await params).event, body ?? {}), 201);
  });
}
