import { crossOriginWrite } from "@/lib/cross-site";
import { hstsFor } from "@/lib/hsts";
import { currentActor, EVENT_FILE_TOO_LARGE, guardImport, HttpError, importEventFile, json, MAX_EVENT_FILE_BYTES, route } from "@/server/dal";

export const dynamic = "force-dynamic";

const tooLarge = () => new HttpError(413, "too_large", EVENT_FILE_TOO_LARGE);

/** The body as text, counted as it arrives and no longer read once it passes the limit. */
async function bodyText(req: Request): Promise<string> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_EVENT_FILE_BYTES) throw tooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_EVENT_FILE_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * POST <event file in the fixture format>: import an event, or add what is new to one; 201 with the report.
 * Administrators only; files up to 64 MB.
 *
 * The proxy (src/proxy.ts) leaves this route out, since it would hold an event file in memory up to its own
 * 10 MB and no further, so the route does the proxy's work itself: a write that the browser marks as sent by a
 * page of another origin is read signed out (its cookies ignored, a Bearer token kept, as the proxy drops them
 * everywhere else), and the answer carries Strict-Transport-Security on an https PUBLIC_URL. The client address
 * is set before any of this runs (scripts/client-address.mjs), and the proxy keeps no rate limit.
 */
export async function POST(req: Request) {
  const res = await route(async () => {
    const actor = await currentActor({ cookie: !crossOriginWrite(req.method, req.headers) });
    // who may import is decided before the body is read, so nobody else makes the server hold a file
    guardImport(actor);
    const text = await bodyText(req);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined; // importEventFile answers 422 for this
    }
    return json(importEventFile(actor, body), 201);
  });
  const hsts = hstsFor(process.env.PUBLIC_URL);
  if (hsts) res.headers.set("Strict-Transport-Security", hsts);
  return res;
}
