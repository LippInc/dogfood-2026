import { cookies } from "next/headers";
import { clientOf } from "@/lib/client";
import { enterVoting, json, route, voteCookieName } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: enter voting with an open or personal link; the voter token comes back as an httpOnly cookie. */
export async function POST(_req: Request, { params }: RouteContext<"/api/vote/[code]">) {
  return route(async () => {
    const { code } = await params;
    const entered = enterVoting(code, await clientOf());
    (await cookies()).set(voteCookieName(entered.eventId), entered.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 60,
      secure: process.env.COOKIE_SECURE === "true",
    });
    return json({ eventId: entered.eventId, eventSlug: entered.eventSlug });
  });
}
