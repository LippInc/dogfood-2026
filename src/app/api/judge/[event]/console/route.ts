import { currentActor, getJudgeConsole, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET /api/judge/[event]/console: the judge's own console -- batches, projects and saved reviews. The event's judges only. */
export async function GET(_req: Request, { params }: RouteContext<"/api/judge/[event]/console">) {
  return route(async () => json(getJudgeConsole(await currentActor(), (await params).event)));
}
