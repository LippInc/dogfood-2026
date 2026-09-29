import { createProject, currentActor, json, route, searchGallery } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * The event's submitted projects, as JSON (public, like the gallery). ?q= searches them as the gallery's search box
 * does (every word, in the title, summary, write-up, team, track, id or tags, case and accents ignored), ?track=<id>
 * keeps one track's and ?tag= the projects carrying that tag; they combine. 422 for a track the event lacks.
 */
export async function GET(req: Request, { params }: RouteContext<"/api/events/[event]/projects">) {
  return route(async () => {
    const { event } = await params;
    const sp = new URL(req.url).searchParams;
    const gallery = searchGallery(event, { q: sp.get("q"), track: sp.get("track"), tag: sp.get("tag") });
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
