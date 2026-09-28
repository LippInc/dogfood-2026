import { currentActor, json, route, unhideComment } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: an organizer shows a hidden comment again. */
export async function POST(_req: Request, { params }: RouteContext<"/api/comments/[comment]/unhide">) {
  return route(async () => json(unhideComment(await currentActor(), (await params).comment)));
}
