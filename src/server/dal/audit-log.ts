import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "../authz";
import { verifyAuditChain } from "../audit";
import { getDb, type DbOrTx } from "../db/client";
import { formatUtc } from "@/lib/format";
import { assignments, auditLog, events, projects, rubricCriteria, teams, tracks, users, voters } from "../db/schema";
import { guardRead } from "../mutate";
import { toCsv } from "../csv";
import { eventFacts, requireEvent } from "./events";
import { votingState } from "./voting";

// The audit log read as sentences ("Jonas Vogel changed Innovation for Paper Anchor
// from 4 to 5"), for the organizer's overview card and the full log page. The
// sentence is built from the row's own before/after, with ids turned into names.
// What a ballot holds stays out of every view of the log until voting closes, the
// same moment the count appears: otherwise an organizer could add up the running
// total from the log. The rows are still stored and hashed in full.

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
  voter: Map<string, string>;
  /** True until the event's voting window has closed: ballot contents are not shown. */
  sealed: boolean;
};

const SEALED = "hidden until voting closes";

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
    voter: new Map(
      db
        .select({ id: voters.id, kind: voters.kind, name: users.name })
        .from(voters)
        .leftJoin(users, eq(users.id, voters.userId))
        .where(eq(voters.eventId, eventId))
        .all()
        .map((v) => [v.id, v.kind === "account" && v.name ? v.name : `${v.kind === "listed" ? "Listed" : "Link"} voter ${v.id.slice(-6)}`]),
    ),
    sealed: ballotsSealed(db, eventId),
  };
}

function ballotsSealed(db: DbOrTx, eventId: string): boolean {
  const e = db.select({ votingOpenAt: events.votingOpenAt, votingCloseAt: events.votingCloseAt }).from(events).where(eq(events.id, eventId)).get();
  return !e || votingState(e) !== "closed";
}

const MODE_WORDS: Record<string, string> = { account: "signed-in accounts", listed: "the voter list", link: "the open link" };
const LIMIT_WORDS: Record<string, string> = { ballot: "ballot saves", comment: "comments", "open-link entry": "open-link entries", "sign-in": "sign-in attempts" };
const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

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
  const voter = (id: unknown): Part => ({ text: n.voter.get(String(id)) ?? String(id), strong: true });
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
    case "voting.settings":
      return after.votingOpenAt && after.votingCloseAt
        ? [
            actor,
            t(
              ` set community voting from ${formatUtc(String(after.votingOpenAt))} to ${formatUtc(String(after.votingCloseAt))}, ` +
                `${after.votesPerVoter} votes each, for ${andList(((after.modes as string[] | undefined) ?? []).map((m) => MODE_WORDS[m] ?? m))}`,
            ),
          ]
        : [actor, t(" cleared the community voting window")];
    case "voting.link":
      return [actor, t(after.replaced ? " made a new open voting link; the old one stopped working" : " made the open voting link")];
    case "voting.voters_added": {
      const added = Number(after.added ?? 0);
      const skipped = Number(after.skipped ?? 0);
      return [actor, t(` added ${added} ${added === 1 ? "person" : "people"} to the voter list${skipped ? ` (${skipped} already on it)` : ""}`)];
    }
    case "voter.join_link":
      return [actor, t(" entered voting with the open link")];
    case "vote.cast": {
      if (n.sealed) return [actor, t(` changed their ballot (${SEALED})`)];
      const picks = ((after.picks as string[] | undefined) ?? []).map(project);
      if (!picks.length) return [actor, t(" cleared their ballot")];
      return [actor, t(" voted for "), ...picks.flatMap((p, i) => (i === 0 ? [p] : [t(i === picks.length - 1 ? " and " : ", "), p]))];
    }
    case "voter.void":
      return [actor, t(" set aside the ballot of "), voter(target), t(`: ${quote(after.reason)}`)];
    case "voter.restore":
      return [actor, t(" counted the ballot of "), voter(target), t(" again")];
    case "comment.post":
      return [actor, t(" commented on "), project(target)];
    case "comment.hide":
      return [actor, t(" hid a comment on "), project(target), t(`: ${quote(after.reason)}`)];
    case "record.issue": {
      const what = after.kind === "judge" ? "judging record" : "certificate";
      return after.subject === r.actorUserId
        ? [actor, t(` got their signed ${what}`)]
        : [actor, t(` issued the signed ${what} of `), person(after.subject)];
    }
    case "records.issue_all":
      return [actor, t(` issued ${after.judges} judging records and ${after.participants} certificates`)];
    case "signing_key.create":
      return [actor, t(" made the signing key "), { text: target, mono: true }];
    case "ratelimit.refused":
      return [actor, t(` was asked to slow down (too many ${LIMIT_WORDS[target] ?? target}; wait ${after.retryAfter} s)`)];
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
  const sealed = ballotsSealed(db, eventId);
  const payload = (r: Row, v: unknown) => (v === null ? "" : sealed && r.action === "vote.cast" ? SEALED : JSON.stringify(v));
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
      payload(r, r.before),
      payload(r, r.after),
      r.prevHash,
      r.hash,
      head.ok ? "yes" : "no",
      head.ok ? (head.head ?? "") : `broken at ${head.brokenAtId}`,
    ]),
  );
}
