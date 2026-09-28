import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // One self-contained server for the container (see Dockerfile).
  output: "standalone",
  // A native module: loaded from node_modules at run time, never bundled.
  serverExternalPackages: ["better-sqlite3"],
  // forbidden() / unauthorized(): designed 403 and 401 pages with real status codes.
  // Event files (MAX_EVENT_FILE_BYTES, 64 MB, in src/server/dal/imports.ts) come in through a server action on
  // /organize and POST /api/imports. Both pass the proxy (src/proxy.ts), which otherwise cuts a body at 10 MB
  // without an error, so both limits sit a little above the import's own, which answers with the plain refusal.
  experimental: { authInterrupts: true, serverActions: { bodySizeLimit: "66mb" }, proxyClientMaxBodySize: "66mb" },
  poweredByHeader: false,
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    return [
      // No page may be framed by another site (clickjacking), except the embeddable gallery.
      {
        source: "/((?!embed/).*)",
        headers: [...common, { key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: "frame-ancestors 'none'" }],
      },
      { source: "/embed/:path*", headers: [...common, { key: "Content-Security-Policy", value: "frame-ancestors * file:" }] },
    ];
  },
};

export default nextConfig;
