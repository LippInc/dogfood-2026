import { currentActor, json, revokeJudgeOverride, route, setJudgeOverride } from "@/server/dal";

export const dynamic = "force-dynamic";

/** POST /api/events/[event]/judges/[judge]/override { mode: "include" | "exclude", reason }: settle a flagged judge by hand; the reason is required and audited. Organizers only. */
export async function POST(req: Request, { params }: RouteContext<"/api/events/[event]/judges/[judge]/override">) {
  return route(async () => {
    const body = (await req.json().catch(() => null)) as { mode?: unknown; reason?: unknown } | null;
    const { event, judge } = await params;
    return json(setJudgeOverride(await currentActor(), event, { judgeUserId: judge, mode: body?.mode, reason: body?.reason ?? "" }));
  });
}

/** DELETE /api/events/[event]/judges/[judge]/override: undo the active override; the flat-judge rule applies again. Organizers only. */
export async function DELETE(_req: Request, { params }: RouteContext<"/api/events/[event]/judges/[judge]/override">) {
  return route(async () => {
    const { event, judge } = await params;
    return json(revokeJudgeOverride(await currentActor(), event, { judgeUserId: judge }));
  });
}
