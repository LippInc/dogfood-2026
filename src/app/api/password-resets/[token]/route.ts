import { describePasswordReset, json, resetPassword, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: whose link this is (email, name); 404 unknown, 410 used or expired. Anyone holding the link. */
export async function GET(_req: Request, { params }: RouteContext<"/api/password-resets/[token]">) {
  return route(async () => json(describePasswordReset((await params).token)));
}

/** POST { password }: set the new password and sign in (sets the session cookie); the account's other sessions end and the link stops working. */
export async function POST(req: Request, { params }: RouteContext<"/api/password-resets/[token]">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(await resetPassword((await params).token, body ?? {}));
  });
}
