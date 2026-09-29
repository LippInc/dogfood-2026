import { currentActor, exportFile, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * Organizer exports (src/server/dal/exports.ts): scores.csv, projects.csv, assignments.csv, normalized.csv, audit.csv,
 * comparisons.csv, votes.csv (the picks sealed until voting closes), comments.csv (a hidden one without its words),
 * each always with a header row, and event.json and fixtures.json.
 */
export async function GET(req: Request, { params }: RouteContext<"/api/events/[event]/export/[file]">) {
  return route(async () => {
    const { event, file } = await params;
    const actor = await currentActor();
    const out = exportFile(actor, event, file);
    // ?bom=1 (the portal's download buttons send it): a UTF-8 byte-order mark, so Excel reads names right.
    const bom = !file.endsWith(".json") && new URL(req.url).searchParams.get("bom") === "1";
    return new Response(bom ? `\uFEFF${out.body}` : out.body, {
      status: 200,
      headers: {
        "content-type": file.endsWith(".json") ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${out.filename}"`,
        "cache-control": "no-store",
      },
    });
  });
}
