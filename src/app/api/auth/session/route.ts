import { currentActor, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/session: whom the request's session belongs to now, { person: { id, name } } or { person: null }.
 * Anyone; never 401 (a visitor is person: null). An open tab asks it when it comes back into view, to learn that
 * another tab of the browser signed in as someone else or signed out, or that its session ended.
 */
export async function GET() {
  return route(async () => {
    const actor = await currentActor();
    return json({ person: actor ? { id: actor.userId, name: actor.name } : null });
  });
}
