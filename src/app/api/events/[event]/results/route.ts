import { getPublishedResults, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/results: the published ranking, per track, from the stored run; { published: false } until results are out. Public. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/results">) {
  return route(async () => json(getPublishedResults((await params).event)));
}
