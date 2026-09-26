import { currentActor, json, recuseAssignment, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/judge/reviews/<assignment>/recuse  { reason }: the judge declares a conflict of interest. */
export async function POST(req: Request, ctx: RouteContext<"/api/judge/reviews/[assignment]/recuse">) {
  return route(async () => {
    const { assignment } = await ctx.params;
    const actor = await currentActor();
    const body = await req.json().catch(() => null);
    return json(recuseAssignment(actor, assignment, body ?? {}));
  });
}
