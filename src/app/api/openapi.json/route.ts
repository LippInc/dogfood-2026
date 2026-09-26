import { json, openApiDocument, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** GET: the OpenAPI 3.1 document for every JSON route. Public, open to any origin. */
export async function GET() {
  return route(() => json(openApiDocument(process.env.PUBLIC_URL ?? "http://localhost:8080"), 200, { "access-control-allow-origin": "*" }));
}
