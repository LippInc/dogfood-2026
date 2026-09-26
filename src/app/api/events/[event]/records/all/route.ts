import { currentActor, issueAllRecords, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST: organizers issue every judge's record and every team member's certificate not issued yet. */
export async function POST(_req: Request, { params }: RouteContext<"/api/events/[event]/records/all">) {
  return route(async () => json(issueAllRecords(await currentActor(), (await params).event)));
}
