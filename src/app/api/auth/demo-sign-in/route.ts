import { json, route, signInAsDemo } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/demo-sign-in { as: "organizer" | "judge_a" | "judge_b" | "participant" }: while demo mode is on,
 * sign in as that demo identity (sets the session cookie), as the sign-in page's demo buttons do. Anyone;
 * 403 demo_sign_in_off when demo mode is off or the label is not one of the four.
 */
export async function POST(req: Request) {
  return route(async () => {
    const body = (await req.json().catch(() => null)) as { as?: unknown } | null;
    const result = await signInAsDemo(String(body?.as ?? ""));
    return result.ok ? json({ userId: result.userId }) : json({ error: "demo_sign_in_off", message: result.message }, 403);
  });
}
