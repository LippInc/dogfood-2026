import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { Db } from "./db/client";
import { users } from "./db/schema";

// Who administers a portal run for a real event: the addresses in ADMIN_EMAILS
// (comma or space separated). An account with one of them is an administrator from
// sign-up on, and an existing one becomes one at the next start; each grant is
// audited. Taking an address out of the list later does not take the role away.

export function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Make every existing account named in ADMIN_EMAILS an administrator; returns the addresses changed. */
export function grantNamedAdmins(db: Db, now: string): string[] {
  const named = [...adminEmails()];
  if (!named.length) return [];
  return db.transaction((tx) => {
    const rows = tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(inArray(users.email, named), eq(users.isAdmin, false)))
      .all();
    for (const u of rows) {
      tx.update(users).set({ isAdmin: true }).where(eq(users.id, u.id)).run();
      appendAudit(
        tx,
        { actorUserId: null, actorLabel: "system", action: "user.admin_granted", targetType: "user", targetId: u.id, before: { isAdmin: false }, after: { isAdmin: true, by: "ADMIN_EMAILS" } },
        now,
      );
    }
    return rows.map((u) => u.email);
  });
}
