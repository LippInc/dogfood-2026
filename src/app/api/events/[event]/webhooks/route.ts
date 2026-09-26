import { createWebhook, currentActor, json, listWebhooks, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: the event's webhooks with delivery counts (secrets never). Organizers only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/webhooks">) {
  return route(async () => json({ webhooks: listWebhooks(await currentActor(), (await params).event).webhooks }));
}

/** POST { url, actions: ["*"] | ["project.submit", ...] }: add a webhook; 201 with its secret, shown this once. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/webhooks">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(await createWebhook(await currentActor(), (await params).event, body ?? {}), 201);
  });
}
