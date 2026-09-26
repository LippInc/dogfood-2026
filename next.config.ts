import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // One self-contained server for the container (see Dockerfile).
  output: "standalone",
  // A native module: loaded from node_modules at run time, never bundled.
  serverExternalPackages: ["better-sqlite3"],
  // forbidden() / unauthorized(): designed 403 and 401 pages with real status codes.
  experimental: { authInterrupts: true },
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
      { source: "/embed/:path*", headers: [...common, { key: "Content-Security-Policy", value: "frame-ancestors *" }] },
    ];
  },
};

export default nextConfig;
