import { currentActor, json, retryDelivery, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: send a delivery again at the worker's next pass. Organizers only. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/webhooks/[webhook]/deliveries/[delivery]/retry">) {
  return route(async () => {
    const { event, webhook, delivery } = await params;
    return json(retryDelivery(await currentActor(), event, webhook, delivery));
  });
}
