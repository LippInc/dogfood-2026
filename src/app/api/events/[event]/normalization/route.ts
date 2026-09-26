import { currentActor, getNormalization, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/normalization: the working view -- method, normalization (with the signal check) and the open decisions. Organizers only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/normalization">) {
  return route(async () => json(getNormalization(await currentActor(), (await params).event)));
}
