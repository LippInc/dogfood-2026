import { currentActor, getCloseCalls, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/close-calls: per track, each ranked project's chance of being first, whether the top is too close to call, and the choice made. Organizers only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/close-calls">) {
  return route(async () => json(getCloseCalls(await currentActor(), (await params).event)));
}
