import { currentActor, json, remindJudges, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/judges/reminders { judge } or { notStarted: true }: mail judges the reminder the Judges page copies, while SMTP_URL is set; one judge at most once an hour (429 with Retry-After). Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/judges/reminders">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(await remindJudges(await currentActor(), (await params).event, body ?? {}));
  });
}
