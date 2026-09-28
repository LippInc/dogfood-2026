import { currentActor, EVENT_FILE_TOO_LARGE, guardImport, HttpError, importEventFile, json, MAX_EVENT_FILE_BYTES, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST <event file in the fixture format>: import an event, or add what is new to one; 201 with the report. Administrators only. */
export async function POST(req: Request) {
  return route(async () => {
    const actor = await currentActor();
    // who may import is decided before the body is read, so nobody else makes the server buffer a file
    guardImport(actor);
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_EVENT_FILE_BYTES) throw new HttpError(413, "too_large", EVENT_FILE_TOO_LARGE);
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_EVENT_FILE_BYTES) throw new HttpError(413, "too_large", EVENT_FILE_TOO_LARGE);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined; // importEventFile answers 422 for this
    }
    return json(importEventFile(actor, body), 201);
  });
}
