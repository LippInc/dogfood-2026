import { addListedVoters, currentActor, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST { emails }: add people to the voter list; each personal link is returned once. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/voting/voters">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(addListedVoters(await currentActor(), (await params).event, body ?? {}), 201);
  });
}
