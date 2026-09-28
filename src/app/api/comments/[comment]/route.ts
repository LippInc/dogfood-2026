import { currentActor, deleteComment, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** DELETE: the author deletes their own comment (not one the organizers hid). */
export async function DELETE(_req: Request, { params }: RouteContext<"/api/comments/[comment]">) {
  return route(async () => json(deleteComment(await currentActor(), (await params).comment)));
}
