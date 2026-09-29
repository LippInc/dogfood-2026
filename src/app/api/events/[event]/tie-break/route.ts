import { currentActor, json, route, setTieBreak } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/tie-break  { criterionId | null, reason }: the criterion that breaks exact score ties; 409 in pairwise mode or once results are published. Organizers only. */
export async function PUT(req: Request, ctx: RouteContext<"/api/events/[event]/tie-break">) {
  return route(async () => {
    const { event } = await ctx.params;
    const actor = await currentActor();
    const body = await req.json().catch(() => null);
    return json(setTieBreak(actor, event, body ?? {}));
  });
}
