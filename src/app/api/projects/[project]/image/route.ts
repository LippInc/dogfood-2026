import { currentActor, HttpError, json, MAX_IMAGE_BYTES, removeProjectImage, route, setProjectImage } from "@/server/dal";

export const dynamic = "force-dynamic";

const tooLarge = () => new HttpError(413, "image_too_large", "The image is over 2 MB. Save a smaller one (1600 pixels wide is plenty) and try again.");

/** The request body, read only up to the limit: a larger upload is refused without reading the rest. */
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
 * bytes; at most 2 MB): upload the project's picture. 201 { id, thumbnailUrl }. Team members only, while
 * submissions are open; 413 over 2 MB, 415 for any other kind of file.
 */
export async function POST(req: Request, { params }: RouteContext<"/api/projects/[project]/image">) {
  return route(async () => {
    const actor = await currentActor();
    const bytes = actor ? await bodyBytes(req) : new Uint8Array(0);
    return json(setProjectImage(actor, (await params).project, bytes), 201);
  });
}

/** DELETE /api/projects/[project]/image: take the picture down; an uploaded one's file goes with it. Team members only, while submissions are open. */
export async function DELETE(_req: Request, { params }: RouteContext<"/api/projects/[project]/image">) {
  return route(async () => json(removeProjectImage(await currentActor(), (await params).project)));
}
