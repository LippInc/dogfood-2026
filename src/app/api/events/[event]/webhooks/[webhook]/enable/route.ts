import { currentActor, json, route, setWebhookEnabled } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: turn a webhook back on. Organizers only. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/webhooks/[webhook]/enable">) {
  return route(async () => {
    const { event, webhook } = await params;
    return json(setWebhookEnabled(await currentActor(), event, webhook, true));
  });
}
