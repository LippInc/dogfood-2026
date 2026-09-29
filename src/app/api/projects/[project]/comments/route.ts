import { currentActor, json, listComments, postComment, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * GET: a project's comments. A hidden one keeps its place with the reason, never its text, for the event's organizers
 * and its author only; everyone else gets one comment fewer.
 */
export async function GET(_req: Request, { params }: RouteContext<"/api/projects/[project]/comments">) {
  return route(async () => json({ comments: listComments(await currentActor(), (await params).project) }));
}

/** POST { body }: comment as the signed-in person. 401 without a session, 403 on a draft, 429 when too fast. */
export async function POST(req: Request, { params }: RouteContext<"/api/projects/[project]/comments">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(postComment(await currentActor(), (await params).project, body ?? {}), 201);
  });
}
