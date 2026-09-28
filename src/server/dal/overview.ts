import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Actor } from "../authz";
import { getDb, type Db } from "../db/client";
import { projects, signedRecords, teams } from "../db/schema";
import { plural } from "@/lib/format";
import { guardRead } from "../mutate";
import { latestAudit, type AuditLine } from "./audit-log";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { judgeRows } from "./judges";
import { computeNormalization } from "./normalization";
import { eventDecisions, type Decision } from "./decisions";
import { computePairwise, judgingModeOf, pairwiseProgress, pullShare } from "./pairwise";
import { voteSummary, type VoteSummary } from "./voting-organizer";

// The organizer's overview (DESIGN.md: one focal point, three levels, details on
// request): the decisions that stand between the scores and the results, the
// publish panel that stays locked until they are made, the event's pipeline, and
// three summary cards (judges, normalization, audit log).

export type Stage = { no: string; name: string; state: string; open: number; done: boolean; current: boolean };

export type Overview = {
  event: EventRow;
  decisions: Decision[];
  open: number;
  /** the submission close while it is still ahead (publishing waits for it), else null */
  submissionsOpenUntil: string | null;
  pipeline: Stage[];
  judges: {
    total: number;
    finished: number;
    reviewsDone: number;
    reviewsAssigned: number;
    unfinished: { id: string; name: string; tracks: string; done: number; assigned: number }[];
    segments: ("done" | "open" | "idle")[];
  };
  normalization: {
    k: number | null;
    beta2: number;
    maxLeniency: number;
    minReviews: number;
    maxReviews: number;
    keptShare: number;
    points: { name: string; n: number; tilt: number; leniency: number }[];
    excludedNames: string[];
    moved: number;
    ranked: number;
  };
  /** the community vote, for the publish panel: publishing closes an open vote and calls off one not yet open */
  vote: VoteSummary;
  /** in pairwise mode: the answers so far and the two pulls the fit measured, as "wins X %" shares; null in scores mode */
  pairwise: { answers: number; placed: number; total: number; left: ReturnType<typeof pullShare>; fresh: ReturnType<typeof pullShare> } | null;
  audit: AuditLine[];
};

const STAGE_OF: Record<Decision["kind"], string> = { duplicate: "04", under_reviewed: "06", flat_judge: "07", coin_flip_judge: "07" };

/**
 * Where an event stands: its decisions and its ten stages, from one run of each engine
 * (reused until the data changes). The overview adds its cards to this; the list of an
 * organizer's events reads only this.
 */
function eventStatus(db: Db, event: EventRow) {
  const now = Date.now();
  const n = computeNormalization(db, event);
  const pairwise = judgingModeOf(event) === "pairwise";
  const progress = pairwise ? pairwiseProgress(db, event) : null;
  const pw = pairwise ? computePairwise(db, event) : null;
  const list = eventDecisions(db, event, { normalization: n, pairwise: pw ?? undefined });
  const open = list.filter((d) => !d.resolved);
  const projectCount = db
    .select({ n: sql<number>`count(*)` })
    .from(projects)
    .where(and(eq(projects.eventId, event.id), eq(projects.status, "submitted"), isNull(projects.duplicateOf)))
    .get()!.n;
  const gallery = { counts: { projects: projectCount } };
  const judges = judgeRows(db, event.id);
  const teamCount = db.select({ n: sql<number>`count(*)` }).from(teams).where(eq(teams.eventId, event.id)).get()!.n;
  const closed = now >= Date.parse(event.submissionsCloseAt);
  const assigned = judges.reduce((s, j) => s + j.assigned, 0);
  const done = judges.reduce((s, j) => s + j.done, 0);
  const openAt = (no: string) => open.filter((d) => STAGE_OF[d.kind] === no).length;
  const closeDay = new Date(event.submissionsCloseAt).toUTCString().slice(5, 11).replace(/^0/, "");

  const issued = db.select({ n: sql<number>`count(*)` }).from(signedRecords).where(eq(signedRecords.eventId, event.id)).get()!.n;
  const stages: Omit<Stage, "current">[] = [
    { no: "01", name: "Registration", state: closed ? "done" : "open", open: 0, done: closed },
    { no: "02", name: "Teams", state: `${teamCount} ${teamCount === 1 ? "team" : "teams"}`, open: 0, done: closed },
    {
      no: "03",
      name: "Submissions",
      state: closed ? `${gallery.counts.projects}, closed ${closeDay}` : `${gallery.counts.projects} so far`,
      open: 0,
      done: closed,
    },
    {
      no: "04",
      name: "Eligibility",
      state: openAt("04") ? `${openAt("04")} to decide` : gallery.counts.projects === 0 ? "nothing yet" : "checked",
      open: openAt("04"),
      done: closed && !openAt("04"),
    },
    {
      no: "05",
      name: "Assignment",
      state: assigned ? plural(judges.length, "judge") : judges.length ? "not run yet" : "no judges yet",
      open: 0,
      done: assigned > 0,
    },
    {
      no: "06",
      name: progress ? "Comparing" : "Scoring",
      state: openAt("06")
        ? `${openAt("06")} to decide`
        : progress
          ? progress.total
            ? `${progress.placed} of ${progress.total} placed`
            : "waiting"
          : assigned
            ? `${done} of ${assigned}`
            : "waiting",
      open: openAt("06"),
      done: progress ? progress.total > 0 && progress.placed === progress.total && !openAt("06") : assigned > 0 && done === assigned && !openAt("06"),
    },
    {
      no: "07",
      name: progress ? "Ranking" : "Normalization",
      state: openAt("07")
        ? `${openAt("07")} to decide`
        : progress
          ? progress.answers || n.ranked
            ? `${plural(progress.answers, "answer")}`
            : "waiting"
          : n.ranked === 0
            ? "waiting"
            : n.variance.k === null
              ? "no leniency found"
              : `k = ${n.variance.k.toFixed(1)}`,
      open: openAt("07"),
      done: (progress ? progress.answers > 0 || n.ranked > 0 : n.ranked > 0) && !openAt("07"),
    },
    {
      no: "08",
      name: "Results",
      state: event.resultsPublishedAt ? "published" : !closed ? "after the close" : open.length ? "locked" : "ready",
      open: 0,
      done: Boolean(event.resultsPublishedAt),
    },
    {
      no: "09",
      name: "Certificates",
      state: !event.resultsPublishedAt ? "after publishing" : issued ? `${issued} ${issued === 1 ? "record" : "records"} issued` : "ready to issue",
      open: 0,
      done: issued > 0,
    },
    { no: "10", name: "Archive", state: "export any time", open: 0, done: false },
  ];
  const firstUndone = stages.findIndex((s) => s.open > 0 || (!s.done && s.no <= "08"));
  const pipeline: Stage[] = stages.map((s, i) => ({ ...s, current: i === firstUndone }));
  return { n, pw, progress, list, open, closed, judges, assigned, done, pipeline };
}

export type EventCard = {
  event: EventRow;
  pipeline: Stage[];
  /** decisions still open */
  open: number;
  judges: { total: number; reviewsDone: number; reviewsAssigned: number };
};

/** The cards on an organizer's list of events: where each stands, without the overview's summary cards. */
export function getEventCards(actor: Actor | null, eventIds: string[]): EventCard[] {
  const db = getDb();
  return eventIds.map((id) => {
    const event = requireEvent(db, id);
    guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
    const s = eventStatus(db, event);
    return { event, pipeline: s.pipeline, open: s.open.length, judges: { total: s.judges.length, reviewsDone: s.done, reviewsAssigned: s.assigned } };
  });
}

export function getOverview(actor: Actor | null, eventIdOrSlug: string): Overview {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const { n, pw, progress, list, open, closed, judges, assigned, done, pipeline } = eventStatus(db, event);
  const kept = n.judges.filter((j) => !j.excluded && j.n > 0);
  const points = kept.filter((j) => j.tilt !== null).map((j) => ({ name: j.name, n: j.n, tilt: j.tilt!, leniency: j.leniency }));
  const unfinished = judges.filter((j) => j.pending > 0);
  return {
    event,
    decisions: list,
    open: open.length,
    submissionsOpenUntil: closed ? null : event.submissionsCloseAt,
    pipeline,
    judges: {
      total: judges.length,
      finished: judges.filter((j) => j.assigned > 0 && j.pending === 0).length,
      reviewsDone: done,
      reviewsAssigned: assigned,
      unfinished: unfinished.map((j) => ({ id: j.id, name: j.name, tracks: j.tracks.map((t) => t.name).join(", "), done: j.done, assigned: j.assigned })),
      segments: judges.map((j) => (j.assigned === 0 ? "idle" : j.pending === 0 ? "done" : "open")),
    },
    normalization: {
      k: n.variance.k,
      beta2: n.variance.beta2,
      maxLeniency: kept.reduce((m, j) => Math.max(m, Math.abs(j.leniency)), 0),
      minReviews: kept.length ? Math.min(...kept.map((j) => j.n)) : 0,
      maxReviews: kept.length ? Math.max(...kept.map((j) => j.n)) : 0,
      keptShare: kept.length ? Math.max(...kept.map((j) => j.shrink)) : 0,
      points,
      excludedNames: n.judges.filter((j) => j.excluded).map((j) => j.name),
      moved: n.moved,
      ranked: n.ranked,
    },
    vote: voteSummary(db, event),
    pairwise: progress && pw ? { ...progress, left: pullShare(pw.fit.left), fresh: pullShare(pw.fit.fresh) } : null,
    audit: latestAudit(db, event.id, 4, [
      "review.submit",
      "review.amend",
      "review.recuse",
      "project.submit",
      "judge.override",
      "judge.override_revoke",
      "judge.remove",
      "project.merge",
      "project.unmerge",
      "project.not_duplicate",
      "project.not_duplicate_undo",
      "project.accept_under_reviewed",
      "project.accept_under_reviewed_undo",
      "assignment.run",
      "assignment.by_hand",
      "assignment.remove",
      "project.track_moved",
      "assignment.recusal_undone",
      "event.judging_mode",
      "results.publish",
      "event.update",
      "voting.settings",
      "voting.link",
      "voting.voters_added",
      "voter.void",
      "voter.restore",
      "comment.hide",
      "fixtures.import",
      "event.create",
      "event.rubric",
    ]),
  };
}
