import { currentActor, json, route, updateProject } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/projects/[project] { title, summary, description, trackId, repoUrl, videoUrl, liveUrl, answers, status: "draft" | "submitted" }: edit the caller's team's project. Team members only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/projects/[project]">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(updateProject(await currentActor(), (await params).project, body ?? {}));
  });
}
