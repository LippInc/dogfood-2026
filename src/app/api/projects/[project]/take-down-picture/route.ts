import { currentActor, json, route, takeDownGalleryImage, takeDownProjectImage } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * POST { reason, galleryUrl? }: an organizer takes a project's picture down, uploaded or linked, at any time; with
 * galleryUrl, that image of its gallery instead. The reason goes into the audit log.
 */
export async function POST(req: Request, { params }: RouteContext<"/api/projects/[project]/take-down-picture">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const project = (await params).project;
    const actor = await currentActor();
    const gallery = typeof body === "object" && body !== null && "galleryUrl" in body && (body as { galleryUrl: unknown }).galleryUrl !== undefined;
    return json(gallery ? takeDownGalleryImage(actor, project, body) : takeDownProjectImage(actor, project, body ?? {}));
  });
}
