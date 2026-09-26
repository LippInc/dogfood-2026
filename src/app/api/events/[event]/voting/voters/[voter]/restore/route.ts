import { currentActor, json, restoreVoter, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: count a set-aside ballot again. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/voting/voters/[voter]/restore">) {
  return route(async () => {
    const { event, voter } = await params;
    return json(restoreVoter(await currentActor(), event, { voterId: voter }));
  });
}
