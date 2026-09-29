import "server-only";
import crypto from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "./db/client";
import { auditLog } from "./db/schema";
import { canonicalJson, nowIso, sha256 } from "./util";
import { enqueueForAudit, sealsValues } from "./webhooks";

export const GENESIS_HASH = "0".repeat(64);

// A row's hash covers its values, and every other field of it is visible to someone: a webhook receiver
// sees the time, the actor, the action and the target, and audit.csv gives the hash of the row before.
// Where the values have few possible forms (a ballot of three picks among 40 projects, three scores from
// 1 to 5) hashing every candidate would find them. So a row whose values some reader may not see yet (the
// actions webhooks.ts seals: ballots, scores and texts, pairwise answers, imports) is hashed with a salt,
// 32 random bytes kept in its own column and shown only where the values are: never in a webhook body; in
// audit.csv from the moment the values are (a ballot once voting closes), so anyone can then recompute
// that row's hash. Every other row, and every row written before salts existed, has none and hashes as
// it always did, so an existing chain still verifies.
function saltFor(action: string): string | null {
  return sealsValues(action) ? crypto.randomBytes(32).toString("hex") : null;
}

export type AuditEntry = {
  actorUserId: string | null;
  actorLabel: string;
  action: string;
  eventId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
};

type ChainedFields = AuditEntry & { at: string; salt?: string | null };

/** The exact bytes a row's hash covers, besides the previous row's hash. A row without a salt has no salt key. */
export function auditPayload(row: ChainedFields): string {
  return canonicalJson({
    at: row.at,
    actorUserId: row.actorUserId,
    actorLabel: row.actorLabel,
    action: row.action,
    eventId: row.eventId ?? null,
    targetType: row.targetType ?? null,
    targetId: row.targetId ?? null,
    before: row.before ?? null,
    after: row.after ?? null,
    ...(row.salt ? { salt: row.salt } : {}),
  });
}

export function chainHash(prevHash: string, row: ChainedFields): string {
  return sha256(`${prevHash}\n${auditPayload(row)}`);
}

/** One entry of the chain and its hash: what a signed record or the published results pin. */
export type ChainAnchor = { entry: number; hash: string };

/** The newest entry of the chain, or null before the first. */
export function chainHead(db: DbOrTx): ChainAnchor | null {
  return db.select({ entry: auditLog.id, hash: auditLog.hash }).from(auditLog).orderBy(desc(auditLog.id)).limit(1).get() ?? null;
}

/** Whether the chain still holds this entry with this hash; a rewrite that reaches it changes the hash. */
export function anchorHolds(db: DbOrTx, anchor: ChainAnchor): boolean {
  return db.select({ hash: auditLog.hash }).from(auditLog).where(eq(auditLog.id, anchor.entry)).get()?.hash === anchor.hash;
}

/**
 * Append one row to the audit log. Call it inside the same synchronous transaction
 * as the change it records; better-sqlite3 transactions serialize writers, so the
 * chain head read here cannot race another append.
 */
export function appendAudit(tx: DbOrTx, entry: AuditEntry, at: string = nowIso()): string {
  const head = tx.select({ hash: auditLog.hash }).from(auditLog).orderBy(desc(auditLog.id)).limit(1).get();
  const prevHash = head?.hash ?? GENESIS_HASH;
  const salt = saltFor(entry.action);
  const row: ChainedFields = { ...entry, at, salt };
  const hash = chainHash(prevHash, row);
  const inserted = tx
    .insert(auditLog)
    .values({
      at,
      actorUserId: entry.actorUserId,
      actorLabel: entry.actorLabel,
      action: entry.action,
      eventId: entry.eventId ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      prevHash,
      hash,
      salt,
    })
    .run();
  // Webhooks subscribed to this action get a delivery queued in the same transaction; never the salt.
  enqueueForAudit(tx, {
    id: Number(inserted.lastInsertRowid),
    at,
    action: entry.action,
    eventId: entry.eventId ?? null,
    actorUserId: entry.actorUserId,
    actorLabel: entry.actorLabel,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    hash,
  });
  return hash;
}

/** `missing`: how many rows SQLite gave ids to that are not in the log, from brokenAtId on. */
export type ChainCheck = { ok: true; rows: number; head: string } | { ok: false; rows: number; brokenAtId: number; missing?: number };

/**
 * Recompute the chain from the first row; any edited, dropped or reordered row breaks it. Rows cut off the end leave
 * what remains a whole chain, and the next row the app writes links to the last one left, so the check also counts
 * ids. AUTOINCREMENT gives each audit row the next id (a rolled-back write gives its ids back) and SQLite keeps the
 * highest it gave in `sqlite_sequence`; nothing in the app lowers that or skips an id. So ids that skip, or a count
 * past the last row, are rows that were removed (or written past by a tool) outside the app. A tripwire for a careless
 * cut, not proof: whoever edits the file can renumber the rows and lower that count too, and what catches them is a
 * head kept outside the portal (DATA-MODEL.md, "The chain").
 */
export function verifyAuditChain(db: DbOrTx): ChainCheck {
  const rows = db.select().from(auditLog).orderBy(auditLog.id).all();
  let prev = GENESIS_HASH;
  let prevId = 0;
  for (const r of rows) {
    if (r.id > prevId + 1) return { ok: false, rows: rows.length, brokenAtId: prevId + 1, missing: r.id - prevId - 1 };
    const expected = chainHash(prev, {
      at: r.at,
      actorUserId: r.actorUserId,
      actorLabel: r.actorLabel,
      action: r.action,
      eventId: r.eventId,
      targetType: r.targetType,
      targetId: r.targetId,
      before: r.before,
      after: r.after,
      salt: r.salt,
    });
    if (r.prevHash !== prev || r.hash !== expected) return { ok: false, rows: rows.length, brokenAtId: r.id };
    prev = r.hash;
    prevId = r.id;
  }
  const written = db.get<{ seq: number } | undefined>(sql`SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'`)?.seq ?? 0;
  if (written > prevId) return { ok: false, rows: rows.length, brokenAtId: prevId + 1, missing: written - prevId };
  return { ok: true, rows: rows.length, head: prev };
}
