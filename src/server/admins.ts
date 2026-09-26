import "server-only";
import { timingSafeEqual } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { Db } from "./db/client";
import { users } from "./db/schema";
import { newSecret, sha256 } from "./util";

// Who administers a portal run for a real event: the addresses in ADMIN_EMAILS
// (comma or space separated). Accounts are not email-verified, so an address alone
// proves nothing: signing up with a named address needs the one-time setup code the
// portal prints in its own log at start (only the operator sees it), and without it
// the sign-up is refused, so nobody can take the address first. The code lives only
// in this process, as a hash, and works once: a restart prints a new one while a
// named address still has no account. Existing accounts are never promoted.

const SETUP = Symbol.for("dogfood.admin-setup-hash");
const store = globalThis as typeof globalThis & { [SETUP]?: string };

export function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * At start: when ADMIN_EMAILS names an address that has no account yet, make this
 * process's setup code and return it for the log. Null when there is nothing to set up.
 */
export function openAdminSetup(db: Db): { code: string; waiting: string[] } | null {
  const named = [...adminEmails()];
  delete store[SETUP];
  if (!named.length) return null;
  const taken = new Set(
    db
      .select({ email: users.email })
      .from(users)
      .where(inArray(users.email, named))
      .all()
      .map((u) => u.email),
  );
  const waiting = named.filter((e) => !taken.has(e));
  if (!waiting.length) return null;
  const code = newSecret(24);
  store[SETUP] = sha256(code);
  return { code, waiting };
}

/** Used: the code made its administrator and makes no other. */
export function consumeSetupCode(): void {
  delete store[SETUP];
}

/** Does this match the setup code printed at start? */
export function setupCodeValid(code: unknown): boolean {
  const hash = store[SETUP];
  if (typeof hash !== "string" || typeof code !== "string" || !code) return false;
  const given = Buffer.from(sha256(code));
  const wanted = Buffer.from(hash);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
