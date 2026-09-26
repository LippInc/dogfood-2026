import { currentActor, json, revokeApiToken, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: revoke one of your tokens; it stops working at once. From a signed-in session, not a token. */
export async function POST(_req: Request, { params }: RouteContext<"/api/tokens/[token]/revoke">) {
  return route(async () => json(revokeApiToken(await currentActor(), (await params).token)));
}
