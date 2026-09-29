import { currentActor, getFinals, json, openFinals, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/finals: the finals rounds with their finalists, panel, progress and order. Organizers only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/finals">) {
  return route(async () => json(getFinals(await currentActor(), (await params).event)));
}

/** POST /api/events/[event]/finals { track?, n? }: open finals for one track or every track, the top N of each suggested as finalists. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/finals">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(openFinals(await currentActor(), (await params).event, body ?? {}), 201);
  });
}
