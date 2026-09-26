import { clientOf } from "@/lib/client";
import { json, route, signUp } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/auth/sign-up { name, email, password, setup? }: create the account and sign it in (sets the session cookie). Anyone; 429 when one network address signs up or in too often. */
export async function POST(req: Request) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(await signUp(body ?? {}, await clientOf()), 201);
  });
}
