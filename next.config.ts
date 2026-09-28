import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // One self-contained server for the container (see Dockerfile).
  output: "standalone",
  // A native module: loaded from node_modules at run time, never bundled.
  serverExternalPackages: ["better-sqlite3"],
  // forbidden() / unauthorized(): designed 403 and 401 pages with real status codes.
  // Server actions take up to 5 MB, and the proxy (src/proxy.ts) holds Next's own 10 MB of a body: both apply to
  // every action and every matched route, anonymous ones included, so they stay small. Event files (up to 64 MB,
  // MAX_EVENT_FILE_BYTES in src/server/dal/imports.ts) go to POST /api/imports instead, which the proxy leaves
  // out and which reads its body itself, after the caller is found to be an administrator.
  experimental: { authInterrupts: true, serverActions: { bodySizeLimit: "5mb" } },
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
