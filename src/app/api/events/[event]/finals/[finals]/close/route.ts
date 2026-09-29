import { closeFinals, currentActor, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/finals/[finals]/close { reason? }: close the finals; a reason when a panelist has not scored every finalist. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/finals/[finals]/close">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const { event, finals } = await params;
    return json(closeFinals(await currentActor(), event, finals, body ?? {}));
  });
}
