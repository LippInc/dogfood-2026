import { currentActor, json, listUpdates, postUpdate, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/events/[event]/updates: the organizers' updates to the event, newest first, as plain text. Anyone. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/updates">) {
  return route(async () => json(listUpdates((await params).event)));
}

/** POST /api/events/[event]/updates { title, body, email? }: post an update; email: true also mails it to the event's participants while SMTP_URL is set. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/updates">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(await postUpdate(await currentActor(), (await params).event, body ?? {}), 201);
  });
}
