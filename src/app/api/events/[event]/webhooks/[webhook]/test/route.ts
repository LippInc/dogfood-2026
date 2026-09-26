import { currentActor, json, route, testWebhook } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: queue a webhook.test delivery to this webhook only. Organizers only. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/webhooks/[webhook]/test">) {
  return route(async () => {
    const { event, webhook } = await params;
    return json(testWebhook(await currentActor(), event, webhook));
  });
}
