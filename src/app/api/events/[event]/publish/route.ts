import { currentActor, json, publishResults, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * POST /api/events/[event]/publish: publish the results; 409 while any decision is open, 409 once published. Organizers only.
 * An open community vote closes with it; one not yet open is called off. Optional body { reason }: needed when a pairwise
 * ranking fit did not settle (409 fit_not_settled without it).
 */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/publish">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => ({}));
    return json(publishResults(await currentActor(), (await params).event, body ?? {}));
  });
}
