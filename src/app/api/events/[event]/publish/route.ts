import { currentActor, json, publishResults, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/publish: publish the results; 409 while any decision is open, 409 once published. Organizers only. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/publish">) {
  return route(async () => json(publishResults(await currentActor(), (await params).event)));
}
