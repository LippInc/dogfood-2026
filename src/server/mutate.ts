import "server-only";
import { appendAudit, type AuditEntry } from "./audit";
import { authorize, type Action, type Actor, type Refusal, type Resource } from "./authz";
import { getDb, type Tx } from "./db/client";
import { AuthzError, RateLimitedError } from "./errors";
import { LIMITS, take } from "./rate-limit";

// The audited write path. Every mutation in the app goes through mutate(): the
// permission check, the change and its audit row commit in ONE synchronous
// better-sqlite3 transaction (ARCHITECTURE.md, rule 1 onward). A 403 refusal is
// itself recorded: the refusal row commits and nothing else does.

type AuditDetail = Omit<AuditEntry, "actorUserId" | "actorLabel" | "action"> & { action?: string };

/** What a change says to the audit log: one row, a row per thing changed, or null when nothing changed. */
export type MutationAudit = AuditDetail | AuditDetail[] | null;

export type MutationSpec<T> = {
  actor: Actor | null;
  /** who the audit row names when there is no session: a voter holding a voting link */
  as?: { label: string } | null;
  action: Action;
  /** Load the facts the decision needs, inside the transaction. May throw NotFoundError. */
  load: (tx: Tx) => Resource;
  /**
   * Make the change; return the result and what the audit row should say, or
   * audit: null when nothing changed (no row is written). A list writes one row
   * each, in order, for a change made of several things (a batch of invitations).
   * Must be synchronous.
   */
  run: (tx: Tx) => { result: T; audit: MutationAudit };
  now?: Date;
  /**
   * A refusal only the database can make: a trigger that reads its own clock refuses a write authorize() let through
   * by the request's (a ballot at the exact close). Map its error to the refusal the app would have given; it is then
   * answered and audited like one, in a transaction of its own since the write's rolled back.
   */
  refusedByDatabase?: (err: unknown) => Refusal | null;
};

type Who = { userId: string | null; name: string };

/** Whose refusals share one limit: an account by its id, a voter holding a link by the name the row gives it. */
const refusalKey = (who: Who) => `refusals:${who.userId ?? `voter:${who.name}`}`;

export function refusalAudit(actor: Who, action: Action, resource: Resource, refusal: Refusal): AuditEntry {
  const eventId = "event" in resource ? resource.event.id : null;
  return {
    actorUserId: actor.userId,
    actorLabel: actor.name,
    action: "authz.refused",
    eventId,
    targetType: resource.kind,
    targetId:
      resource.kind === "judge_scores"
        ? resource.judgeUserId
        : resource.kind === "assignment"
          ? resource.id
          : resource.kind === "ballot"
            ? (resource.voter?.id ?? eventId)
            : resource.kind === "project_comments"
              ? resource.projectId
              : resource.kind === "comment"
                ? resource.commentId
                : eventId,
    after: { attempted: action, status: refusal.status, code: refusal.code },
  };
}

export function mutate<T>(spec: MutationSpec<T>): T {
  const now = spec.now ?? new Date();
  // A session actor, or (for a ballot) the voter the link proves.
  const who: Who | null = spec.actor
    ? { userId: spec.actor.userId, name: spec.actor.name }
    : spec.as
      ? { userId: null, name: spec.as.label }
      : null;
  let outcome: { refused: Refusal } | { throttled: number } | { result: T };
  try {
    outcome = transact(spec, who, now);
  } catch (err) {
    const refusal = spec.refusedByDatabase?.(err);
    if (!refusal) throw err;
    outcome = getDb().transaction((tx): { refused: Refusal } | { throttled: number } => {
      if (refusal.status === 403 && who) {
        const allowed = take(refusalKey(who), LIMITS.refusal, now.getTime());
        if (!allowed.ok) return { throttled: allowed.retryAfter };
        appendAudit(tx, refusalAudit(who, spec.action, spec.load(tx), refusal), now.toISOString());
      }
      return { refused: refusal };
    });
  }
  if ("throttled" in outcome) throw new RateLimitedError(outcome.throttled);
  if ("refused" in outcome) throw new AuthzError(outcome.refused);
  return outcome.result;
}

/** The permission check, the change and its audit rows, or the audited refusal: one synchronous transaction. */
function transact<T>(spec: MutationSpec<T>, who: Who | null, now: Date): { refused: Refusal } | { throttled: number } | { result: T } {
  return getDb().transaction((tx): { refused: Refusal } | { throttled: number } | { result: T } => {
    const resource = spec.load(tx);
    const decision = authorize(spec.actor, spec.action, resource, now);
    if (!decision.ok) {
      if (decision.status === 403 && who) {
        // One row per 403, up to LIMITS.refusal per person; past that the answer is 429 and no row.
        const allowed = take(refusalKey(who), LIMITS.refusal, now.getTime());
        if (!allowed.ok) return { throttled: allowed.retryAfter };
        appendAudit(tx, refusalAudit(who, spec.action, resource, decision), now.toISOString());
      }
      return { refused: decision };
    }
    if (!who) throw new Error(`authorize() allowed ${spec.action} with nobody to record`);
    const { result, audit } = spec.run(tx);
    for (const row of audit === null ? [] : Array.isArray(audit) ? audit : [audit]) {
      appendAudit(tx, { ...row, actorUserId: who.userId, actorLabel: who.name, action: row.action ?? spec.action }, now.toISOString());
    }
    return { result };
  });
}

/**
 * The read-side gate: decide, record a 403 refusal in the audit log, and throw on
 * any refusal. Reads that pass leave no audit row. Mode "read" by default; before a
 * write that happens further down (an import), mode "write" asks the same question as
 * that write, so its refusal is audited here instead of vanishing with the write's
 * rolled-back transaction.
 */
export function guardRead(actor: Actor | null, action: Action, resource: Resource, now = new Date(), mode: "read" | "write" = "read"): Actor {
  const decision = authorize(actor, action, resource, now, mode);
  if (decision.ok) return actor!;
  if (decision.status === 403 && actor) {
    const allowed = take(refusalKey({ userId: actor.userId, name: actor.name }), LIMITS.refusal, now.getTime());
    if (!allowed.ok) throw new RateLimitedError(allowed.retryAfter);
    getDb().transaction((tx) => {
      appendAudit(tx, refusalAudit({ userId: actor.userId, name: actor.name }, action, resource, decision), now.toISOString());
    });
  }
  throw new AuthzError(decision);
}
