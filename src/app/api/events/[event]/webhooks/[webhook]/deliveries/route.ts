import { currentActor, json, listDeliveries, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: the webhook's last 50 deliveries, newest first, with payload and answer. Organizers only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/webhooks/[webhook]/deliveries">) {
  return route(async () => {
    const { event, webhook } = await params;
    return json({ deliveries: listDeliveries(await currentActor(), event, webhook) });
  });
}
