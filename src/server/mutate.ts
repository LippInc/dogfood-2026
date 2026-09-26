import "server-only";
import { appendAudit, type AuditEntry } from "./audit";
import { authorize, type Action, type Actor, type Refusal, type Resource } from "./authz";
import { getDb, type Tx } from "./db/client";
import { AuthzError } from "./errors";

// The audited write path. Every mutation in the app goes through mutate(): the
// permission check, the change and its audit row commit in ONE synchronous
// better-sqlite3 transaction (BUILD-PLAN decisions 13 and 16). A 403 refusal is
// itself recorded: the refusal row commits and nothing else does.

type AuditDetail = Omit<AuditEntry, "actorUserId" | "actorLabel" | "action"> & { action?: string };

export type MutationSpec<T> = {
  actor: Actor | null;
  action: Action;
  /** Load the facts the decision needs, inside the transaction. May throw NotFoundError. */
  load: (tx: Tx) => Resource;
  /** Make the change; return the result and what the audit row should say. Must be synchronous. */
  run: (tx: Tx) => { result: T; audit: AuditDetail };
  now?: Date;
};

export function refusalAudit(actor: Actor, action: Action, resource: Resource, refusal: Refusal): AuditEntry {
  const eventId = "event" in resource ? resource.event.id : null;
  return {
    actorUserId: actor.userId,
    actorLabel: actor.name,
    action: "authz.refused",
    eventId,
    targetType: resource.kind,
    targetId: resource.kind === "judge_scores" ? resource.judgeUserId : eventId,
    after: { attempted: action, status: refusal.status, code: refusal.code },
  };
}

export function mutate<T>(spec: MutationSpec<T>): T {
  const now = spec.now ?? new Date();
  const outcome = getDb().transaction((tx): { refused: Refusal } | { result: T } => {
    const resource = spec.load(tx);
    const decision = authorize(spec.actor, spec.action, resource, now);
    if (!decision.ok) {
      if (decision.status === 403 && spec.actor) {
        appendAudit(tx, refusalAudit(spec.actor, spec.action, resource, decision), now.toISOString());
      }
      return { refused: decision };
    }
    const actor = spec.actor!; // authorize() refuses a null actor for every mutation
    const { result, audit } = spec.run(tx);
    appendAudit(
      tx,
      { ...audit, actorUserId: actor.userId, actorLabel: actor.name, action: audit.action ?? spec.action },
      now.toISOString(),
    );
    return { result };
  });
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
    getDb().transaction((tx) => {
      appendAudit(tx, refusalAudit(actor, action, resource, decision), now.toISOString());
    });
  }
  throw new AuthzError(decision);
}
