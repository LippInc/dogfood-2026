import "server-only";
import { headers } from "next/headers";
import type { Client } from "@/server/dal";

/**
 * The requester's address and browser, for rate limits and duplicate flags only.
 * Next.js fills x-forwarded-for from the socket when a request arrives without one;
 * a client talking to the portal directly can send its own, so address-based limits
 * are best-effort unless a reverse proxy overwrites the header (README says so).
 */
export async function clientOf(): Promise<Client> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  return { ip, agent: h.get("user-agent") };
}
