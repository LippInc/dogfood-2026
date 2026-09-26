import { getRecord, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: one signed record and this portal's check of its signature. Public: the record id is the share link. */
export async function GET(_req: Request, { params }: RouteContext<"/api/records/[record]">) {
  return route(async () => {
    const r = getRecord((await params).record);
    return json({ envelope: r.envelope, verification: r.verification }, 200, { "access-control-allow-origin": "*" });
  });
}
