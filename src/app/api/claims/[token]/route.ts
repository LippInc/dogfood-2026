import { claimAccount, describeClaim, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: whose link this is (email, name, event); 404 unknown, 410 used or expired. Anyone holding the link. */
export async function GET(_req: Request, { params }: RouteContext<"/api/claims/[token]">) {
  return route(async () => json(describeClaim((await params).token)));
}

/** POST { password, name? }: set the password and sign in (sets the session cookie); the link then stops working. */
export async function POST(req: Request, { params }: RouteContext<"/api/claims/[token]">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(await claimAccount((await params).token, body ?? {}));
  });
}
