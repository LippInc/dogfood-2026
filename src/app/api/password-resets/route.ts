import { currentActor, json, mailPasswordReset, makePasswordReset, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST { email }: a one-time link for that account to set a new password, returned once, and mailed to the account's own address when email is on. Administrators only. */
export async function POST(req: Request) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const actor = await currentActor();
    const link = makePasswordReset(actor, body ?? {});
    return json({ ...link, mail: await mailPasswordReset(actor, link) }, 201);
  });
}
