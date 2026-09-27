import "server-only";
import { appendAudit, type AuditEntry } from "./audit";
import { authorize, type Action, type Actor, type Refusal, type Resource } from "./authz";
import { getDb, type Tx } from "./db/client";
import { AuthzError, RateLimitedError } from "./errors";
import { LIMITS, take } from "./rate-limit";

// The audited write path. Every mutation in the app goes through mutate(): the
// permission check, the change and its audit row commit in ONE synchronous
// better-sqlite3 transaction (BUILD-PLAN decisions 13 and 16). A 403 refusal is
// itself recorded: the refusal row commits and nothing else does.

type AuditDetail = Omit<AuditEntry, "actorUserId" | "actorLabel" | "action"> & { action?: string };

export type MutationSpec<T> = {
  actor: Actor | null;
  /** who the audit row names when there is no session: a voter holding a voting link */
  as?: { label: string } | null;
  action: Action;
  /** Load the facts the decision needs, inside the transaction. May throw NotFoundError. */
  load: (tx: Tx) => Resource;
  /**
   * Make the change; return the result and what the audit row should say, or
   * audit: null when nothing changed (no row is written). Must be synchronous.
   */
  run: (tx: Tx) => { result: T; audit: AuditDetail | null };
  now?: Date;
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
              : eventId,
    after: { attempted: action, status: refusal.status, code: refusal.code },
  };
}

export function mutate<T>(spec: MutationSpec<T>): T {
  const now = spec.now ?? new Date();
  const outcome = getDb().transaction((tx): { refused: Refusal } | { throttled: number } | { result: T } => {
    const resource = spec.load(tx);
    const decision = authorize(spec.actor, spec.action, resource, now);
    // A session actor, or (for a ballot) the voter the link proves.
    const who: Who | null = spec.actor
      ? { userId: spec.actor.userId, name: spec.actor.name }
      : spec.as
        ? { userId: null, name: spec.as.label }
        : null;
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
    if (audit) {
      appendAudit(tx, { ...audit, actorUserId: who.userId, actorLabel: who.name, action: audit.action ?? spec.action }, now.toISOString());
    }
    return { result };
  });
  if ("throttled" in outcome) throw new RateLimitedError(outcome.throttled);
  if ("refused" in outcome) throw new AuthzError(outcome.refused);
  return outcome.result;
}

/**
 * The read-side gate: decide, record a 403 refusal in the audit log, and throw on
 * any refusal. Reads that pass leave no audit row.
 */
export function guardRead(actor: Actor | null, action: Action, resource: Resource, now = new Date()): Actor {
  const decision = authorize(actor, action, resource, now);
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
