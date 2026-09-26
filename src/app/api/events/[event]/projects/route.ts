import { createProject, currentActor, getGallery, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** The event's submitted projects, as JSON (public, like the gallery). */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/projects">) {
  return route(async () => {
    const { event } = await params;
    const gallery = getGallery(event);
    return json({ event: gallery.event, projects: gallery.projects });
  });
}

/**
 * Submit a project as a member of a team in this event. Refused with 401 without a
 * session, and with 403 when the person is on no team or submissions are closed;
 * only an allowed request has its body validated.
 */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/projects">) {
  return route(async () => {
    const { event } = await params;
    const actor = await currentActor();
    const body: unknown = await req.json().catch(() => null);
    const project = createProject(actor, event, body);
    return json({ project }, 201);
  });
}
