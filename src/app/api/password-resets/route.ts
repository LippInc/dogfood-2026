import { currentActor, json, makePasswordReset, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST { email }: a one-time link for that account to set a new password, returned once. Administrators only. */
export async function POST(req: Request) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(makePasswordReset(await currentActor(), body ?? {}), 201);
  });
}
