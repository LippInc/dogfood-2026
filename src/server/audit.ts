import "server-only";
import { desc } from "drizzle-orm";
import type { DbOrTx } from "./db/client";
import { auditLog } from "./db/schema";
import { canonicalJson, nowIso, sha256 } from "./util";
import { enqueueForAudit } from "./webhooks";

export const GENESIS_HASH = "0".repeat(64);

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

type ChainedFields = AuditEntry & { at: string };

/** The exact bytes a row's hash covers, besides the previous row's hash. */
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
  });
}

export function chainHash(prevHash: string, row: ChainedFields): string {
  return sha256(`${prevHash}\n${auditPayload(row)}`);
}

/**
 * Append one row to the audit log. Call it inside the same synchronous transaction
 * as the change it records; better-sqlite3 transactions serialize writers, so the
 * chain head read here cannot race another append.
 */
export function appendAudit(tx: DbOrTx, entry: AuditEntry, at: string = nowIso()): string {
  const head = tx.select({ hash: auditLog.hash }).from(auditLog).orderBy(desc(auditLog.id)).limit(1).get();
  const prevHash = head?.hash ?? GENESIS_HASH;
  const row: ChainedFields = { ...entry, at };
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
    })
    .run();
  // Webhooks subscribed to this action get a delivery queued in the same transaction.
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

export type ChainCheck = { ok: true; rows: number; head: string } | { ok: false; rows: number; brokenAtId: number };

/** Recompute the chain from the first row; any edited, dropped or reordered row breaks it. */
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
    });
    if (r.prevHash !== prev || r.hash !== expected) return { ok: false, rows: rows.length, brokenAtId: r.id };
    prev = r.hash;
  }
  return { ok: true, rows: rows.length, head: prev };
}
