import { currentActor, json, readImageBody, removeProjectImage, route, setProjectImage } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/[project]/image, the image file itself as the body (PNG, JPEG or WebP, told by its
 * bytes; at most 8 MB and 50 megapixels): upload the project's picture, stored as a WebP the portal draws
 * from its pixels. 201 { id, thumbnailUrl }. Team members only, while submissions are open; 413 over
 * either limit, 415 for any other kind of file or one that does not decode.
 */
export async function POST(req: Request, { params }: RouteContext<"/api/projects/[project]/image">) {
  return route(async () => {
    const actor = await currentActor();
    const bytes = actor ? await readImageBody(req) : new Uint8Array(0);
    return json(await setProjectImage(actor, (await params).project, bytes), 201);
  });
}

/** DELETE /api/projects/[project]/image: take the picture down; an uploaded one's file goes with it. Team members only, while submissions are open. */
export async function DELETE(_req: Request, { params }: RouteContext<"/api/projects/[project]/image">) {
  return route(async () => json(removeProjectImage(await currentActor(), (await params).project)));
}
