import { clientOf } from "@/lib/client";
import { json, RateLimitedError, route, signInWithPassword } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/auth/sign-in { email, password }: start a session (sets the cookie). Anyone; a wrong pair is 401 bad_credentials, too many tries 429. */
export async function POST(req: Request) {
  return route(async () => {
    const body = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
    const result = await signInWithPassword(String(body?.email ?? ""), String(body?.password ?? ""), await clientOf());
    if (!result.ok && result.retryAfter) throw new RateLimitedError(result.retryAfter);
    return result.ok ? json({ userId: result.userId }) : json({ error: "bad_credentials", message: result.message }, 401);
  });
}
