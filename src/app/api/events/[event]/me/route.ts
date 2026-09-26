import { currentActor, getMyWork, HttpError, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/me: the caller's team and project in the event. Any signed-in person; 401 without a session. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/me">) {
  return route(async () => {
    const actor = await currentActor();
    if (!actor) throw new HttpError(401, "unauthenticated", "Sign in first: this request carried no valid session.");
    return json(getMyWork(actor, (await params).event));
  });
}
