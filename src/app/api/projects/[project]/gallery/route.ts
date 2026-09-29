import { addGalleryImage, currentActor, json, readImageBody, route, setGallery } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/[project]/gallery, the image file itself as the body (PNG, JPEG or WebP, told by its bytes; at
 * most 8 MB and 50 megapixels): add an uploaded image to the end of the project's gallery, stored as a WebP the portal
 * draws from its pixels. 201 { id, url, galleryUrls }. Team members only, while submissions are open; 409 gallery_full
 * at 6 images, 413 over either limit, 415 for any other kind of file or one that does not decode.
 */
export async function POST(req: Request, { params }: RouteContext<"/api/projects/[project]/gallery">) {
  return route(async () => {
    const actor = await currentActor();
    const bytes = actor ? await readImageBody(req) : new Uint8Array(0);
    return json(await addGalleryImage(actor, (await params).project, bytes), 201);
  });
}

/**
 * PUT /api/projects/[project]/gallery { galleryUrls, expected? }: the gallery's images in their new order, fewer of
 * them, or with an image address added; an upload left out is deleted. Uploads it names must be the gallery's own.
 * 409 gallery_changed when expected (the list the caller last saw) is not the stored one. Team members only, while
 * submissions are open.
 */
export async function PUT(req: Request, { params }: RouteContext<"/api/projects/[project]/gallery">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(setGallery(await currentActor(), (await params).project, body ?? {}));
  });
}
