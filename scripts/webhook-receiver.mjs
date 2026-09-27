// webhook-receiver.mjs — watch this portal's webhooks arrive and check their signatures.
//
// It listens on a port and prints one line per delivery: the time, the event type
// and the audit row it came from, and whether the Dogfood-Signature header is
// right. The check is the one a real receiver should make: HMAC-SHA256 over
// `${t}.${body}` with the webhook's secret, compared in constant time, and a
// timestamp no more than five minutes old. Only Node built-ins.
//
// Usage: node scripts/webhook-receiver.mjs [--port 9911] [--host 127.0.0.1] [--secret <secret>]
//   --secret  the secret the Integrations tab showed when the webhook was added
//             (or WEBHOOK_SECRET in the environment); without it, signatures are
//             not checked.
//
// The portal in Docker reaches your machine at http://host.docker.internal:<port>/
// (Docker Desktop on macOS and Windows; this script's default host works there).
// On Linux, give the portal service `extra_hosts: ["host.docker.internal:host-gateway"]`
// and run this with --host 0.0.0.0. The portal refuses private and local webhook
// targets unless WEBHOOKS_ALLOW_PRIVATE is "true" in docker-compose.yml.
import crypto from "node:crypto";
import http from "node:http";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(option("--port", "9911"));
const host = option("--host", "127.0.0.1");
const secret = option("--secret", process.env.WEBHOOK_SECRET);

function signature(header, body) {
  if (!secret) return "not checked (no --secret)";
  const parts = Object.fromEntries(String(header ?? "").split(",").map((kv) => kv.split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return "INVALID: no t=…,v1=… header";
  if (Math.abs(Date.now() / 1000 - t) > 300) return "INVALID: older than five minutes";
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? "valid" : "INVALID: does not match the secret";
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let what = `${body.length} bytes`;
      try {
        const d = JSON.parse(body);
        what = [d.type, d.data?.auditId !== undefined ? `audit row ${d.data.auditId}` : null, d.id].filter(Boolean).join(" · ");
      } catch {
        // not JSON: the byte count stands
      }
      console.log(`${new Date().toISOString()}  ${req.method} ${req.url}  ${what}  signature: ${signature(req.headers["dogfood-signature"], body)}`);
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    });
  })
  .listen(port, host, () => console.log(`listening on http://${host}:${port}/ ${secret ? "(checking signatures)" : "(no --secret: signatures not checked)"}`));
