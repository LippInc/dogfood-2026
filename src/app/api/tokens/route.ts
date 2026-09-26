import { createApiToken, currentActor, json, listApiTokens, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: your API tokens (names, hints, dates; never the tokens). From a signed-in session, not a token. */
export async function GET() {
  return route(async () => json({ tokens: listApiTokens(await currentActor()) }));
}

/** POST { name, days: 1..365 | null }: a new token, returned this once. From a signed-in session, not a token. */
export async function POST(req: Request) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(createApiToken(await currentActor(), body ?? {}), 201);
  });
}
