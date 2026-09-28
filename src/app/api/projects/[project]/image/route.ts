import { currentActor, HttpError, json, MAX_IMAGE_BYTES, removeProjectImage, route, setProjectImage } from "@/server/dal";

export const dynamic = "force-dynamic";

const tooLarge = () => new HttpError(413, "image_too_large", "The image is over 8 MB. Save a smaller one and try again.");

/** The request body, counted as it arrives and refused past the limit (Next's proxy in front of /api may already hold up to 10 MB of it). */
async function bodyBytes(req: Request): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) throw tooLarge();
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/**
 * POST /api/projects/[project]/image, the image file itself as the body (PNG, JPEG or WebP, told by its
 * bytes; at most 8 MB and 50 megapixels): upload the project's picture, stored as a WebP the portal draws
 * from its pixels. 201 { id, thumbnailUrl }. Team members only, while submissions are open; 413 over
 * either limit, 415 for any other kind of file or one that does not decode.
 */
export async function POST(req: Request, { params }: RouteContext<"/api/projects/[project]/image">) {
  return route(async () => {
    const actor = await currentActor();
    const bytes = actor ? await bodyBytes(req) : new Uint8Array(0);
    return json(await setProjectImage(actor, (await params).project, bytes), 201);
  });
}

/** DELETE /api/projects/[project]/image: take the picture down; an uploaded one's file goes with it. Team members only, while submissions are open. */
export async function DELETE(_req: Request, { params }: RouteContext<"/api/projects/[project]/image">) {
  return route(async () => json(removeProjectImage(await currentActor(), (await params).project)));
}
