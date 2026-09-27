import "server-only";
import { headers } from "next/headers";
import type { Client } from "@/server/dal";

/**
 * The requester's address and browser, for rate limits and duplicate flags only. In the
 * image, scripts/client-address.mjs has already rewritten x-forwarded-for to one address:
 * the connection's own, or with TRUST_PROXY_HOPS the one the trusted proxies saw, so what
 * a client writes there is ignored. Under `next dev` (no preload) the header is as sent.
 */
export async function clientOf(): Promise<Client> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  return { ip, agent: h.get("user-agent") };
}
