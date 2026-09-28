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
      // The portal uses no camera, microphone, location, payment or USB device, so no page (nor anything framed in one) may ask.
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
    ];
    // What a policy can hold without breaking the app: no plugins, no <base> pointing elsewhere, forms that post
    // only here. Scripts and styles stay as Next serves them (inline bootstrap scripts), and pictures come from
    // any https host a team names, so those are not restricted. Strict-Transport-Security is set per request in
    // src/proxy.ts, only when PUBLIC_URL is https (the offline run is http).
    const policy = "base-uri 'self'; form-action 'self'; object-src 'none'";
    return [
      // No page may be framed by another site (clickjacking), except the embeddable gallery.
      {
        source: "/((?!embed/).*)",
        headers: [...common, { key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: `${policy}; frame-ancestors 'none'` }],
      },
      { source: "/embed/:path*", headers: [...common, { key: "Content-Security-Policy", value: `${policy}; frame-ancestors * file:` }] },
    ];
  },
};

export default nextConfig;
