import { currentActor, issueOwnRecordRequest, json, listRecords, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: every record issued for the event (organizers). */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/records">) {
  return route(async () => json({ records: listRecords(await currentActor(), (await params).event) }));
}

/** POST { kind: "judge" | "participant" }: the caller's own record; 201 when issued now, 200 when it existed. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/records">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    const issued = issueOwnRecordRequest(await currentActor(), (await params).event, body ?? {});
    return json({ id: issued.id, url: `/records/${issued.id}`, json: `/api/records/${issued.id}` }, issued.created ? 201 : 200);
  });
}
