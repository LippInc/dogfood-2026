import { currentActor, exportFile, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** Organizer exports: scores.csv, projects.csv, normalized.csv, audit.csv (always a header row) and event.json. */
export async function GET(_req: Request, { params }: RouteContext<"/api/events/[event]/export/[file]">) {
  return route(async () => {
    const { event, file } = await params;
    const actor = await currentActor();
    const out = exportFile(actor, event, file);
    return new Response(out.body, {
      status: 200,
      headers: {
        "content-type": file.endsWith(".json") ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${out.filename}"`,
        "cache-control": "no-store",
      },
    });
  });
}
