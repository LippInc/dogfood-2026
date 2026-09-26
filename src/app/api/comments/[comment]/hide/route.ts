import { currentActor, hideComment, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST { reason }: an organizer hides a comment; the reason shows in its place. */
export async function POST(req: Request, { params }: RouteContext<"/api/comments/[comment]/hide">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(hideComment(await currentActor(), (await params).comment, body ?? {}));
  });
}
