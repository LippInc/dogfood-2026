import { currentActor, json, route, voidVoter } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST { reason }: set a ballot aside as a suspected duplicate. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/voting/voters/[voter]/void">) {
  return route(async () => {
    const { event, voter } = await params;
    const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
    return json(voidVoter(await currentActor(), event, { voterId: voter, reason: body?.reason ?? "" }));
  });
}
