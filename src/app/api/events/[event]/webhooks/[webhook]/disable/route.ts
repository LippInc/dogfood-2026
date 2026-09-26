import { currentActor, json, route, setWebhookEnabled } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: turn a webhook off; queued deliveries stop. Organizers only. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/webhooks/[webhook]/disable">) {
  return route(async () => {
    const { event, webhook } = await params;
    return json(setWebhookEnabled(await currentActor(), event, webhook, false));
  });
}
