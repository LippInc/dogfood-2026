import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // One self-contained server for the container (see Dockerfile).
  output: "standalone",
  // A native module: loaded from node_modules at run time, never bundled.
  serverExternalPackages: ["better-sqlite3"],
  // forbidden() / unauthorized(): designed 403 and 401 pages with real status codes.
  experimental: { authInterrupts: true },
  poweredByHeader: false,
};

export default nextConfig;
