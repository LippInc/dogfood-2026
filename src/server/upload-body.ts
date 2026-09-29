import "server-only";
import { HttpError } from "./errors";
import { MAX_IMAGE_BYTES } from "./uploads";

const tooLarge = () => new HttpError(413, "image_too_large", "The image is over 8 MB. Save a smaller one and try again.");

/**
 * An image upload's request body, counted as it arrives and refused past MAX_IMAGE_BYTES (Next's proxy in front of
 * /api may already hold up to 10 MB of it). The picture's and the gallery's upload routes both read it this way.
 */
export async function readImageBody(req: Request): Promise<Uint8Array> {
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
