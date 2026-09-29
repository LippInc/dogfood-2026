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

/** `cut`: how many rows are missing from the end (brokenAtId is then the first of them). */
export type ChainCheck = { ok: true; rows: number; head: string } | { ok: false; rows: number; brokenAtId: number; cut?: number };

/**
 * Recompute the chain from the first row; any edited, dropped or reordered row breaks it. Rows cut off the end leave
 * what remains a whole chain, so the check also reads SQLite's own count for the table: `sqlite_sequence` holds the
 * highest id AUTOINCREMENT ever gave an audit row (a rolled-back write puts it back; nothing in the app lowers it, and
 * the triggers keep every new row at the end). When it is past the last row, the rows between were removed. A
 * tripwire for a careless cut, not proof: whoever edits the file can lower that count too, and what catches them is a
 * head kept outside the portal (DATA-MODEL.md, "The chain").
 */
export function verifyAuditChain(db: DbOrTx): ChainCheck {
  const rows = db.select().from(auditLog).orderBy(auditLog.id).all();
  let prev = GENESIS_HASH;
  for (const r of rows) {
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
  }
  const last = rows.at(-1)?.id ?? 0;
  const written = db.get<{ seq: number } | undefined>(sql`SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'`)?.seq ?? 0;
  if (written > last) return { ok: false, rows: rows.length, brokenAtId: last + 1, cut: written - last };
  return { ok: true, rows: rows.length, head: prev };
}
