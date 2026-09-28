import { readUpload } from "@/server/dal";

export const dynamic = "force-dynamic";

/**
 * GET /uploads/[file]: an uploaded project picture from the data volume. Only names the portal made
 * (random, with the kind read from the bytes at upload) are served, as the image type the name says;
 * nosniff so no browser reads one as anything else. Anything else is a plain 404.
 */
export async function GET(_req: Request, { params }: RouteContext<"/uploads/[file]">) {
  const file = readUpload((await params).file);
  if (!file) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.type,
      "content-length": String(file.bytes.length),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // a name never changes its bytes (a new upload is a new name), but a taken-down picture should not
      // outlive its take-down in a shared cache for long
      "cache-control": "public, max-age=3600",
    },
  });
}
