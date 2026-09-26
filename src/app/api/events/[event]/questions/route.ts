import { currentActor, json, route, saveQuestions } from "@/server/dal";

export const dynamic = "force-dynamic";

/** PUT /api/events/[event]/questions <rows array>: replace the custom questions teams answer on the project form. Organizers only. */
export async function PUT(req: Request, { params }: RouteContext<"/api/events/[event]/questions">) {
  return route(async () => {
    const body: unknown = await req.json().catch(() => null);
    return json(saveQuestions(await currentActor(), (await params).event, body ?? {}));
  });
}
