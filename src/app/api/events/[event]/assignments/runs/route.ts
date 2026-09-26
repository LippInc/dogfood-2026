import { currentActor, json, route, runAssignment } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/assignments/runs { mode: "fresh" | "topup", seed?, reviewsPerProject?, bridgePerTrack? }: run the assignment engine (a top-up keeps every existing pair). Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/assignments/runs">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(runAssignment(await currentActor(), (await params).event, body ?? {}), 201);
  });
}
