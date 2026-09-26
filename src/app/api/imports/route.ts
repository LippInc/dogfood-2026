import { currentActor, HttpError, importEventFile, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5_000_000;

/** POST <event file in the fixture format>: import an event, or add what is new to one; 201 with the report. Administrators only. */
export async function POST(req: Request) {
  return route(async () => {
    const actor = await currentActor();
    const text = await req.text();
    if (text.length > MAX_BYTES) throw new HttpError(413, "too_large", "Event files are limited to 5 MB.");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined; // importEventFile refuses a caller without permission first, then answers 422 for this
    }
    return json(importEventFile(actor, body), 201);
  });
}
