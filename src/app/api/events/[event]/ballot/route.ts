import { cookies } from "next/headers";
import { clientOf } from "@/lib/client";
import { castBallot, currentActor, eventRef, getBallot, json, route, voteCookieName } from "@/server/dal";

export const dynamic = "force-dynamic";

async function voterToken(eventId: string) {
  return (await cookies()).get(voteCookieName(eventId))?.value ?? null;
}

/** GET: the requester's own ballot (projects in their seeded order, their picks). Public; picks need a voter. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/ballot">) {
  return route(async () => {
    const { id } = eventRef((await params).event);
    const b = getBallot(await currentActor(), id, await voterToken(id));
    return json({
      state: b.state,
      votesPerVoter: b.votesPerVoter,
      modes: b.modes,
      voter: b.voter ? { id: b.voter.id, kind: b.voter.kind, voided: b.voter.voided } : null,
      projects: b.projects.map((p) => ({ id: p.id, title: p.title })),
      picks: b.picks,
    });
  });
}

/** PUT { projectIds }: replace the ballot. 401 with no voter, 403 outside the window or when set aside, 422 over the limit, 429 when too fast. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/ballot">) {
  return route(async () => {
    const { id } = eventRef((await params).event);
    const body: unknown = await req.json().catch(() => null);
    const out = castBallot(await currentActor(), id, await voterToken(id), body ?? {}, await clientOf());
    return json({ picks: out.picks });
  });
}
