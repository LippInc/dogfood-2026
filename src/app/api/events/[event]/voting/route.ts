import { currentActor, getVotingAdmin, json, route, saveVotingSettings } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: the organizer's view (settings, turnout, suspected duplicates; the tally only after closing). */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/voting">) {
  return route(async () => {
    const v = getVotingAdmin(await currentActor(), (await params).event);
    return json({ state: v.state, settings: v.settings, turnout: v.turnout, suspected: v.suspected, listed: v.listed, tally: v.tally });
  });
}

/** PUT { votingOpenAt, votingCloseAt ("YYYY-MM-DDTHH:MM", UTC), modes, votesPerVoter }: organizers only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/voting">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(saveVotingSettings(await currentActor(), (await params).event, body ?? {}));
  });
}
