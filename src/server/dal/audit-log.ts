import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "../authz";
import { verifyAuditChain } from "../audit";
import { getDb, type DbOrTx } from "../db/client";
import { assignments, auditLog, projects, rubricCriteria, teams, tracks, users } from "../db/schema";
import { guardRead } from "../mutate";
import { toCsv } from "../csv";
import { eventFacts, requireEvent } from "./events";

// The audit log read as sentences ("Jonas Vogel changed Innovation for Paper Anchor
// from 4 to 5"), for the organizer's overview card and the full log page. The
// sentence is built from the row's own before/after, with ids turned into names.

export type Part = { text: string; strong?: boolean; mono?: boolean };

export type AuditLine = {
  id: number;
  at: string;
  action: string;
  actor: string;
  parts: Part[];
  targetType: string | null;
  targetId: string | null;
  hash: string;
};

type Row = typeof auditLog.$inferSelect;

type Names = {
  user: Map<string, string>;
  project: Map<string, string>;
  team: Map<string, string>;
  track: Map<string, string>;
  criterion: Map<string, string>;
  assignment: Map<string, { judgeId: string; projectId: string }>;
};

function loadNames(db: DbOrTx, eventId: string): Names {
  return {
    user: new Map(db.select({ id: users.id, name: users.name }).from(users).all().map((u) => [u.id, u.name])),
    project: new Map(db.select({ id: projects.id, title: projects.title }).from(projects).where(eq(projects.eventId, eventId)).all().map((p) => [p.id, p.title])),
    team: new Map(db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.eventId, eventId)).all().map((t) => [t.id, t.name])),
    track: new Map(db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, eventId)).all().map((t) => [t.id, t.name])),
    criterion: new Map(
      db.select({ key: rubricCriteria.key, label: rubricCriteria.label }).from(rubricCriteria).where(eq(rubricCriteria.eventId, eventId)).all().map((c) => [c.key, c.label]),
    ),
    assignment: new Map(
      db
        .select({ id: assignments.id, judgeId: assignments.judgeUserId, projectId: assignments.projectId })
        .from(assignments)
        .where(eq(assignments.eventId, eventId))
        .all()
        .map((a) => [a.id, { judgeId: a.judgeId, projectId: a.projectId }]),
    ),
  };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const quote = (s: unknown) => `“${String(s ?? "")}”`;

function sentence(r: Row, n: Names): Part[] {
  const label = r.actorUserId ? (n.user.get(r.actorUserId) ?? r.actorLabel) : r.actorLabel;
  const actor: Part = { text: label.charAt(0).toUpperCase() + label.slice(1), strong: true };
  const after = obj(r.after);
  const before = obj(r.before);
  const project = (id: unknown): Part => ({ text: n.project.get(String(id)) ?? String(id), strong: true });
  const person = (id: unknown): Part => ({ text: n.user.get(String(id)) ?? String(id), strong: true });
  const t = (text: string): Part => ({ text });
  const target = r.targetId ?? "";
  switch (r.action) {
    case "fixtures.import":
      return [actor, t(" imported the fixture file")];
    case "checker_sessions.issued":
      return [actor, t(" issued the four checker sessions")];
    case "checker_sessions.removed":
      return [actor, t(" removed the checker sessions")];
    case "user.sign_up":
      return [actor, t(" created an account")];
    case "session.sign_in":
      return [actor, t(" signed in")];
    case "session.sign_in_demo":
      return [actor, t(" signed in with a demo identity")];
    case "event.create":
      return [actor, t(" created the event")];
    case "event.update":
      return [actor, t(` changed the event's ${Object.keys(after).join(", ") || "details"}`)];
    case "event.tracks":
    case "event.prizes":
    case "event.questions":
    case "event.rubric":
      return [actor, t(` changed the ${r.action.split(".")[1]}`)];
    case "team.create":
      return [actor, t(" created team "), { text: n.team.get(target) ?? target, strong: true }];
    case "team.join":
      return [actor, t(" joined "), { text: n.team.get(target) ?? target, strong: true }];
    case "team.invite_rotated":
      return [actor, t(" replaced the invite link of "), { text: n.team.get(target) ?? target, strong: true }];
    case "project.submit":
      return [actor, t(" submitted "), project(target), { text: ` ${target}`, mono: true }];
    case "project.create":
      return [actor, t(" saved a first draft of "), project(target)];
    case "project.update":
      return [actor, t(" edited "), project(target)];
    case "judge.invite":
      return [actor, t(` made a judge invitation for ${after.name || after.email || "an open link"}`)];
    case "judge.invite_revoke":
      return [actor, t(" revoked a judge invitation")];
    case "judge.join":
      return [actor, t(" joined as a judge")];
    case "judge.tracks":
      return [actor, t(" changed the tracks of "), person(target)];
    case "assignment.run":
      return [
        actor,
        t(` ran ${after.mode === "fresh" ? "the assignment" : "a top-up"}: ${after.added ?? 0} reviews assigned, seed `),
        { text: String(after.seed ?? ""), mono: true },
      ];
    case "assignment.by_hand":
      return [actor, t(" gave "), project(target), t(" to "), person(after.judgeUserId), t(` by hand: ${quote(after.reason)}`)];
    case "review.save":
    case "review.submit":
    case "review.amend": {
      const a = n.assignment.get(target);
      const proj = project(after.project ?? a?.projectId ?? "");
      const keys = Object.keys(after).filter((k) => n.criterion.has(k));
      if (r.action === "review.amend" && keys.length === 1) {
        const k = keys[0]!;
        return [actor, t(` changed ${n.criterion.get(k)} for `), proj, t(` from ${before[k] ?? "–"} to ${after[k] ?? "–"}`)];
      }
      if (r.action === "review.submit") return [actor, t(" finished scoring "), proj, t(typeof after.total === "number" ? `: ${after.total.toFixed(2)}` : "")];
      if (r.action === "review.amend") return [actor, t(" changed the score for "), proj];
      return [actor, t(" saved a draft score for "), proj];
    }
    case "review.recuse": {
      const a = n.assignment.get(target);
      return [actor, t(" declared a conflict of interest on "), project(after.project ?? a?.projectId), t(`: ${quote(after.reason)}`)];
    }
    case "judge.override":
      return [actor, t(after.mode === "include" ? " reinstated " : " left out "), person(target), t(`: ${quote(after.reason)}`)];
    case "judge.override_revoke":
      return [actor, t(" undid the override on "), person(target)];
    case "project.merge":
      return [actor, t(" merged "), project(target), { text: ` ${target}`, mono: true }, t(" into "), { text: String(after.into), mono: true }];
    case "project.unmerge":
      return [actor, t(" undid the merge of "), project(target)];
    case "project.not_duplicate":
      return [actor, t(` ruled ${(after.ids as string[] | undefined)?.join(" and ") ?? target} are different projects: ${quote(after.reason)}`)];
    case "project.accept_under_reviewed":
      return [actor, t(" will publish "), project(target), t(` with fewer than two reviews: ${quote(after.reason)}`)];
    case "results.publish":
      return [actor, t(" published the results")];
    case "authz.refused":
      return [actor, t(` was refused: ${after.attempted ?? "an action"} (${after.code ?? after.status})`)];
    default:
      return [actor, t(` ${r.action}`)];
  }
}

function lines(db: DbOrTx, eventId: string, rows: Row[]): AuditLine[] {
  const names = loadNames(db, eventId);
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    actor: r.actorLabel,
    parts: sentence(r, names),
    targetType: r.targetType,
    targetId: r.targetId,
    hash: r.hash,
  }));
}

/** The latest entries of one event's log, newest first. DAL-internal (the overview card). */
export function latestAudit(db: DbOrTx, eventId: string, limit = 4, actions?: string[]): AuditLine[] {
  const where = actions ? and(eq(auditLog.eventId, eventId), inArray(auditLog.action, actions)) : eq(auditLog.eventId, eventId);
  return lines(db, eventId, db.select().from(auditLog).where(where).orderBy(desc(auditLog.id)).limit(limit).all());
}

export function getAuditLog(actor: Actor | null, eventIdOrSlug: string, opts: { limit?: number } = {}) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const rows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.eventId, event.id))
    .orderBy(desc(auditLog.id))
    .limit(opts.limit ?? 500)
    .all();
  const total = db.$count(auditLog, eq(auditLog.eventId, event.id));
  return { event, lines: lines(db, event.id, rows), total, chain: verifyAuditChain(db) };
}

/** The event's log as CSV, oldest first, every row with its own hash and the one before. */
export function auditCsv(db: DbOrTx, eventId: string): string {
  const rows = db.select().from(auditLog).where(eq(auditLog.eventId, eventId)).orderBy(auditLog.id).all();
  const text = lines(db, eventId, rows);
  const head = verifyAuditChain(db);
  return toCsv(
    ["id", "at", "actor", "action", "sentence", "target_type", "target_id", "before", "after", "prev_hash", "hash", "chain_ok", "chain_head"],
    rows.map((r, i) => [
      r.id,
      r.at,
      r.actorLabel,
      r.action,
      text[i]!.parts.map((p) => p.text).join(""),
      r.targetType ?? "",
      r.targetId ?? "",
      r.before === null ? "" : JSON.stringify(r.before),
      r.after === null ? "" : JSON.stringify(r.after),
      r.prevHash,
      r.hash,
      head.ok ? "yes" : "no",
      head.ok ? (head.head ?? "") : `broken at ${head.brokenAtId}`,
    ]),
  );
}
