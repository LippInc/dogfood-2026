// Loaded before the server: node --import ./scripts/client-address.mjs server.js (Dockerfile).
//
// The rate limits and the duplicate-ballot flags key on the requester's network address,
// which the app reads from X-Forwarded-For. Next.js fills that header from the connection
// only when a request arrives without one, so a client talking to the portal directly
// could name any address it liked. This rewrites the header on every request before
// Next.js sees it: by default to the connection's own address; with TRUST_PROXY_HOPS=n
// (n reverse proxies in front, each appending the address it saw), to the address the
// outermost of them saw. Whatever a client wrote further left is ignored, and X-Real-IP
// is dropped. Standard library only.
import http from "node:http";

/**
 * The address to use, from the header as it arrived, the socket's own address and the
 * number of trusted proxies: step `hops` places left from the socket along the chain.
 * A chain shorter than that (fewer proxies appended than promised) falls back to the
 * socket rather than to whatever a client wrote first.
 */
export function clientAddress(forwardedFor, socketAddress, hops) {
  const chain = String(forwardedFor || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (socketAddress) chain.push(socketAddress);
  const n = Number.isInteger(hops) && hops > 0 ? hops : 0;
  const i = chain.length - 1 - n;
  return i >= 0 ? chain[i] : socketAddress || null;
}

/** Rewrite the header on every request an http server emits; returns the undo. */
export function install(http, hops) {
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, req, ...rest) {
    if (event === "request" && req && req.headers) {
      const address = clientAddress(req.headers["x-forwarded-for"], req.socket && req.socket.remoteAddress, hops);
      if (address) req.headers["x-forwarded-for"] = address;
      else delete req.headers["x-forwarded-for"];
      delete req.headers["x-real-ip"];
    }
    return emit.call(this, event, req, ...rest);
  };
  return () => {
    http.Server.prototype.emit = emit;
  };
}

if (!process.env.VITEST) install(http, Number(process.env.TRUST_PROXY_HOPS || 0));
