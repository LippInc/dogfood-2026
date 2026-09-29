import { json, openApiDocument, publicUrl, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: the OpenAPI 3.1 document for every JSON route. Public, open to any origin. */
export async function GET() {
  return route(() => json(openApiDocument(publicUrl()), 200, { "access-control-allow-origin": "*" }));
}
