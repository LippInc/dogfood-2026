import { currentActor, json, rotateWebhookSecret, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: a new signing secret, returned once; the old one stops at once. Organizers only. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/webhooks/[webhook]/rotate-secret">) {
  return route(async () => {
    const { event, webhook } = await params;
    return json(rotateWebhookSecret(await currentActor(), event, webhook));
  });
}
