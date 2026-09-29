import "server-only";
// An event's history in its event file: what the portal's own fixtures.json export carries beyond the organizers'
// format (dal/exports.ts eventHistory), and how an import restores it. All of it comes into a NEW event only; into an
// event that is here already a row the event holds counts as present, and a file that would add one is refused whole
// (409 new_event_only), so an import never adds a ballot, a comment, a pairwise answer, a merge, a decision or a
// published ranking to an event that is running here.
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "./client";
import { ConflictError } from "../errors";
import { canonicalJson, newSecret, sha256 } from "../util";
import { atMost, dateTime, id } from "./fixture-fields";
import { readTrackMoves, type TrackMove } from "./track-moves";
import {
  comments,
  comparisons,
  events,
  judgeOverrides,
  normalizationRuns,
  normalizedScores,
  PAIRWISE_OUTCOMES,
  prizes,
  projects,
  voters,
  votes,
  type EventSettings,
} from "./schema";

// ---------------------------------------------------------------------------
// The file's shape
// ---------------------------------------------------------------------------

/** How many rows of each part one file may bring (the whole history of one event arrives in one file). */
export const HISTORY_LIMITS = { prizes: 40, decisions: 2_000, changes: 500, comparisons: 50_000, ballots: 50_000, picks: 20, comments: 20_000, published: 2_000 } as const;

/** SQLite's trim() takes off spaces only; the database's checks count what is left, so the file is held to the same count. */
const sqlTrimmed = (s: string) => s.replace(/^ +| +$/g, "");
const reason = z
  .string()
  .max(2_000)
  .refine((s) => sqlTrimmed(s).length >= 3, "must say why, in at least 3 characters");
/** An address as the database keeps one (lowercased, with an '@' after its first character), as team members' are taken. */
const address = z
  .string()
  .trim()
  .toLowerCase()
  .refine((s) => s.indexOf("@") >= 1 && s.length <= 320, "must be an email address");
const VOTE_MODES = ["account", "listed", "link"] as const;
const voteRules = z.looseObject({ modes: z.array(z.enum(VOTE_MODES)).max(3), votesPerVoter: z.number().int().min(1).max(20) });
const pair = z.string().refine((s) => {
  const [a, b, ...rest] = s.split("|");
  return rest.length === 0 && id.safeParse(a).success && id.safeParse(b).success;
}, "must be two project ids joined by '|'");

/** Keys the event object may carry beyond the organizers' format: the event's other dates. */
export const EventDates = {
  submissions_open: dateTime.optional(),
  judging_close: dateTime.optional(),
  voting_open: dateTime.optional(),
  voting_close: dateTime.optional(),
};

/** Top-level keys an event file may carry beyond the organizers' format (each optional; the boot fixture has none). */
export const HistoryFields = {
  settings: z
    .object({
      max_team_size: z.number().int().min(1).max(20).optional(),
      certificate_places: z.number().int().min(1).max(20).optional(),
      reviews_per_project: z.number().int().min(1).max(10).optional(),
      judge_ranking: z.boolean().optional(),
      judging_mode: z.enum(["scores", "pairwise"]).optional(),
      accent: z.string().max(40).optional(),
      voting: z
        .object({
          modes: z.array(z.enum(VOTE_MODES)).max(3),
          votes_per_voter: z.number().int().min(1).max(20),
          count_link: z.boolean().optional(),
          link_per_address: z.number().int().min(1).max(5000).optional(),
        })
        .optional(),
    })
    .optional(),
  prizes: z
    .array(z.object({ id, name: z.string().trim().min(1).max(80), description: z.string().max(500).optional().default("") }))
    .max(HISTORY_LIMITS.prizes, `at most ${HISTORY_LIMITS.prizes} prizes, as on the Settings tab`)
    .optional(),
  decisions: z
    .object({
      judges: z
        .array(z.object({ id, judge: id, mode: z.enum(["include", "exclude"]), reason, at: dateTime, revoked_at: dateTime.optional() }))
        .max(HISTORY_LIMITS.decisions, atMost(HISTORY_LIMITS.decisions, "judge decisions"))
        .optional()
        .default([]),
      not_duplicates: z.array(pair).max(HISTORY_LIMITS.decisions, atMost(HISTORY_LIMITS.decisions, "pairs")).optional().default([]),
      accepted_under_reviewed: z.array(id).max(HISTORY_LIMITS.decisions, atMost(HISTORY_LIMITS.decisions, "projects")).optional().default([]),
      weight_changes: z
        .array(
          z.looseObject({
            at: dateTime,
            reason: z.string().max(2_000),
            before: z.array(z.looseObject({ id: z.string().max(200), label: z.string().max(200), weight: z.number() })).max(64),
            after: z.array(z.looseObject({ id: z.string().max(200), label: z.string().max(200), weight: z.number() })).max(64),
          }),
        )
        .max(HISTORY_LIMITS.changes)
        .optional()
        .default([]),
      vote_rule_changes: z
        .array(z.looseObject({ at: dateTime, reason: z.string().max(2_000), before: voteRules, after: voteRules }))
        .max(HISTORY_LIMITS.changes)
        .optional()
        .default([]),
      track_moves: z
        .array(z.object({ project: id, from: id, to: id, reason: z.string().max(2_000), at: dateTime }))
        .max(HISTORY_LIMITS.decisions, atMost(HISTORY_LIMITS.decisions, "track moves"))
        .optional()
        .default([]),
      vote_count_changes: z
        .array(
          z.looseObject({
            at: dateTime,
            kind: z.enum(["merge", "unmerge"]),
            keep: z.looseObject({ id, title: z.string().max(500) }),
            duplicate: z.looseObject({ id, title: z.string().max(500) }),
            moves: z.array(z.looseObject({ projectId: id, title: z.string().max(500), before: z.number().nullable(), after: z.number().nullable() })).max(4_000),
          }),
        )
        .max(HISTORY_LIMITS.changes)
        .optional()
        .default([]),
    })
    .optional(),
  comparisons: z
    .array(
      z.object({
        id,
        judge: id,
        track: id,
        left: id,
        right: id,
        new: id,
        answer: z.enum(PAIRWISE_OUTCOMES),
        at: dateTime,
        taken_back_at: dateTime.optional(),
      }),
    )
    .max(HISTORY_LIMITS.comparisons, atMost(HISTORY_LIMITS.comparisons, "pairwise answers"))
    .optional(),
  ballots: z
    .array(
      z.object({
        id,
        voter: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("account"), email: address }),
          z.object({ kind: z.literal("listed"), email: address }),
          z.object({ kind: z.literal("link") }),
        ]),
        order_seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        created_at: dateTime,
        last_voted_at: dateTime.optional(),
        set_aside: z.object({ at: dateTime, reason }).optional(),
        picks: z
          .array(z.object({ project: id, at: dateTime }))
          .max(HISTORY_LIMITS.picks, `at most ${HISTORY_LIMITS.picks} picks on one ballot`)
          .optional()
          .default([]),
      }),
    )
    .max(HISTORY_LIMITS.ballots, atMost(HISTORY_LIMITS.ballots, "ballots"))
    .optional(),
  /** how many ballots stayed behind because voting had not closed when the file was made (their picks are sealed) */
  ballots_sealed: z.number().int().min(0).optional(),
  comments: z
    .array(
      z.object({
        id,
        project: id,
        author: address,
        author_name: z.string().max(1_000).optional(),
        body: z
          .string()
          .max(4_000)
          .refine((s) => sqlTrimmed(s).length >= 1 && sqlTrimmed(s).length <= 2_000, "must be 1 to 2,000 characters, as a comment is"),
        at: dateTime,
        hidden: z.object({ at: dateTime, reason }).optional(),
      }),
    )
    .max(HISTORY_LIMITS.comments, atMost(HISTORY_LIMITS.comments, "comments"))
    .optional(),
  published: z
    .object({
      at: dateTime,
      run: z.object({
        id,
        // the two engines' names, as the database's check on normalization_runs.method has them
        method: z.enum(["leniency-shrunk-v1", "bradley-terry-v1"]),
        computed_at: dateTime,
        params: z.record(z.string(), z.unknown()),
      }),
      scores: z
        .array(
          z.object({
            project: id,
            n: z.number().int().min(0),
            raw_mean: z.number().nullable(),
            normalized_mean: z.number().nullable(),
            se: z.number().nullable(),
            rank_raw: z.number().nullable(),
            rank_normalized: z.number().nullable(),
          }),
        )
        .max(HISTORY_LIMITS.published, atMost(HISTORY_LIMITS.published, "published rows")),
    })
    .optional(),
};

/** The parts of an event file the history reads, for its type. */
export const HistoryShape = z.object({ ...HistoryFields, projects: z.array(z.object({ id, duplicate_of: id.optional() })) });
type History = z.infer<typeof HistoryShape>;
type FileDates = { submissions_close: string } & { [K in keyof typeof EventDates]?: string };

/** The event's settings a file gives, in the settings column's own form (never the open link or the published run). */
export function settingsFromFile(file: Pick<History, "settings">): EventSettings {
  const s = file.settings;
  if (!s) return {};
  const out: EventSettings = {};
  if (s.max_team_size !== undefined) out.maxTeamSize = s.max_team_size;
  if (s.certificate_places !== undefined) out.certificatePlaces = s.certificate_places;
  if (s.reviews_per_project !== undefined) out.reviewsPerProject = s.reviews_per_project;
  if (s.judge_ranking !== undefined) out.judgeRanking = s.judge_ranking;
  if (s.judging_mode !== undefined) out.judgingMode = s.judging_mode;
  if (s.accent !== undefined) out.accent = s.accent;
  if (s.voting) {
    out.voting = {
      modes: [...s.voting.modes],
      votesPerVoter: s.voting.votes_per_voter,
      ...(s.voting.count_link !== undefined ? { countLink: s.voting.count_link } : {}),
      ...(s.voting.link_per_address !== undefined ? { linkPerAddress: s.voting.link_per_address } : {}),
    };
  }
  return out;
}

/**
 * The database's own orders on an event's dates, checked before the insert so a file gets a 422 naming the date, not a
 * 500; and a published event's vote ended by its publication at the latest, as publishing ends a vote here.
 */
export function checkDates(event: FileDates, publishedAt: string | undefined, issue: (path: string, message: string) => void) {
  const t = (s: string | undefined) => (s ? Date.parse(s) : null);
  const open = t(event.submissions_open);
  if (open !== null && open >= t(event.submissions_close)!) issue("submissions_open", "must be before submissions_close");
  const vo = t(event.voting_open);
  const vc = t(event.voting_close);
  if (vo !== null && vc !== null && vo >= vc) issue("voting_open", "must be before voting_close");
  if (publishedAt && vc !== null && vc > Date.parse(publishedAt)) issue("voting_close", "must be no later than published.at: publishing ends the vote");
}

// ---------------------------------------------------------------------------
// An event that is here already: present or refused
// ---------------------------------------------------------------------------

type Counts = { present: number; missing: number };
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/**
 * For an event that is here: the history rows the file carries that the event already holds (by id, in this
 * event) are present; any other would be added, and then the whole import is refused, naming what the file carries.
 * Returns the present counts for the report.
 */
export function refuseHistoryForExistingEvent(
  tx: Tx,
  file: History,
  eventId: string,
  published: { at: string | null; runId: string | null; settings: EventSettings },
  projectOf: Map<string, string>,
  trackOf: Map<string, string>,
) {
  // a row an earlier import brought under a renamed id ('<id>.<event id>', another event held the file's) is present too
  const renamed = (x: string) => `${x}.${eventId}`;
  const idsIn = (table: typeof comments | typeof comparisons | typeof judgeOverrides | typeof voters, ids: string[]) => {
    const held = new Set<string>();
    // in slices, so a file of 50,000 ballots stays inside SQLite's limit on one statement's variables
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      for (const r of tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.eventId, eventId), inArray(table.id, [...slice, ...slice.map(renamed)])))
        .all())
        held.add(r.id);
    }
    return new Set(ids.filter((x) => held.has(x) || held.has(renamed(x))));
  };
  const own = (x: string) => projectOf.get(x) ?? x;
  const count = (ids: string[], held: Set<string>): Counts => ({ present: ids.filter((i) => held.has(i)).length, missing: ids.filter((i) => !held.has(i)).length });
  const ballotIds = (file.ballots ?? []).map((b) => b.id);
  const commentIds = (file.comments ?? []).map((c) => c.id);
  const answerIds = (file.comparisons ?? []).map((c) => c.id);
  const decisionIds = (file.decisions?.judges ?? []).map((d) => d.id);
  const ballots = count(ballotIds, idsIn(voters, ballotIds));
  const commentCount = count(commentIds, idsIn(comments, commentIds));
  const answers = count(answerIds, idsIn(comparisons, answerIds));
  const judgeDecisions = count(decisionIds, idsIn(judgeOverrides, decisionIds));

  const s = published.settings;
  const inList = <T>(list: T[] | undefined, held: T[] | undefined): Counts => {
    const have = new Set((held ?? []).map((x) => canonicalJson(x)));
    const all = list ?? [];
    const missing = all.filter((x) => !have.has(canonicalJson(x))).length;
    return { present: all.length - missing, missing };
  };
  const d = file.decisions;
  const settingsDecisions = [
    inList(
      d?.not_duplicates.map((p) => p.split("|").map(own).sort().join("|")),
      s.notDuplicates,
    ),
    inList(d?.accepted_under_reviewed.map(own), s.acceptedUnderReviewed),
    inList(d?.weight_changes, s.weightChanges),
    inList(d?.vote_rule_changes, s.voteRuleChanges),
    inList(remapIds(d?.vote_count_changes, projectOf) as unknown[] | undefined, s.voteCountChanges),
    inList(
      d?.track_moves.map((m) => ({ project: own(m.project), from: trackOf.get(m.from) ?? m.from, to: trackOf.get(m.to) ?? m.to, reason: m.reason, at: m.at })),
      (d?.track_moves.length ? readTrackMoves(tx, eventId) : []).map((m) => ({ project: m.projectId, from: m.fromTrackId, to: m.toTrackId, reason: m.reason, at: m.at })),
    ),
  ];
  const otherDecisions = settingsDecisions.reduce((a, c) => ({ present: a.present + c.present, missing: a.missing + c.missing }), { present: 0, missing: 0 });

  const mergesInFile = file.projects.filter((p) => p.duplicate_of);
  const heldMerges = new Map(
    mergesInFile.length
      ? tx
          .select({ id: projects.id, duplicateOf: projects.duplicateOf })
          .from(projects)
          .where(and(eq(projects.eventId, eventId), inArray(projects.id, mergesInFile.map((p) => own(p.id)))))
          .all()
          .map((p) => [p.id, p.duplicateOf])
      : [],
  );
  const merges = { present: 0, missing: 0 };
  for (const p of mergesInFile) {
    if (heldMerges.get(own(p.id)) === own(p.duplicate_of!)) merges.present++;
    else merges.missing++;
  }

  const runHere = file.published && published.at !== null && (published.runId === file.published.run.id || published.runId === renamed(file.published.run.id));
  const ranking = file.published ? (runHere ? { present: 1, missing: 0 } : { present: 0, missing: 1 }) : { present: 0, missing: 0 };

  const adds: string[] = [];
  if (ballots.missing) adds.push(plural(ballots.missing, "ballot"));
  if (commentCount.missing) adds.push(plural(commentCount.missing, "comment"));
  if (answers.missing) adds.push(plural(answers.missing, "pairwise answer"));
  if (merges.missing) adds.push(plural(merges.missing, "duplicate merge"));
  if (judgeDecisions.missing + otherDecisions.missing) adds.push(plural(judgeDecisions.missing + otherDecisions.missing, "decision"));
  if (ranking.missing) adds.push("a published ranking");
  if (adds.length) {
    const list = adds.length === 1 ? adds[0] : `${adds.slice(0, -1).join(", ")} and ${adds.at(-1)}`;
    throw new ConflictError(
      "new_event_only",
      `This event is here already, and the file would add ${list} to it. An import brings those only into a new event: give the file an event id of its own to import it as one. Nothing was imported.`,
    );
  }
  return {
    voters: ballots.present,
    comments: commentCount.present,
    comparisons: answers.present,
    judgeOverrides: judgeDecisions.present,
    normalizationRuns: ranking.present,
  };
}

// ---------------------------------------------------------------------------
// A new event: restore it all
// ---------------------------------------------------------------------------

export type HistoryTable = "prizes" | "judgeOverrides" | "comparisons" | "voters" | "votes" | "comments" | "normalizationRuns" | "normalizedScores";

/** What the restore brought, by id, for the import's audit row (a ballot by its voter and how many picks, never the picks). */
export type RestoredHistory = {
  prizes: string[];
  merges: { duplicate: string; into: string }[];
  decisions: string[];
  comparisons: string[];
  ballots: { voter: string; picks: number }[];
  comments: string[];
  published?: { run: string; at: string };
  /** projects moved to another track on the portal the event came from; the event's track moves are read from here too */
  trackMoves?: TrackMove[];
};

export type RestoreContext = {
  eventId: string;
  /** who the restored decisions, set-aside ballots and hidden comments are recorded as done by here: the importer */
  by: string;
  projectOf: Map<string, string>;
  trackOf: Map<string, string>;
  /** the file's judge ids and the accounts that judge here */
  accountOf: Map<string, string>;
  /** the file's projects this import holds (created, or the event's own) */
  imported: Set<string>;
  /** each file project's file track */
  trackOfProject: Map<string, string>;
  /** the account for an address (found, or made without a password as the importer makes members'); null when it cannot be */
  userFor: (email: string, name?: string) => string | null;
  bump: (table: HistoryTable, changes: number) => void;
  skip: (kind: string, id: string, reason: string) => void;
};

/** A file id for a row of one of these tables: the id itself when no other event holds it, else the id with this event's after it. */
function freeId(tx: Tx, table: typeof prizes | typeof comments | typeof comparisons | typeof judgeOverrides | typeof voters | typeof normalizationRuns, fileId: string, eventId: string, kind: string, renamed: (from: string, to: string) => void): string {
  const holder = (x: string) => tx.select({ e: table.eventId }).from(table).where(eq(table.id, x)).get()?.e;
  if (holder(fileId) === undefined) return fileId;
  const other = `${fileId}.${eventId}`;
  if (holder(other) !== undefined) throw new ConflictError("id_taken", `The ${kind} ids ${fileId} and ${other} both belong to other events; give this file's ids a prefix of their own.`);
  renamed(fileId, other);
  return other;
}

/** Every string in a stored value that is one of the renamed ids, replaced by the id it got here. */
export function remapIds(value: unknown, renamed: Map<string, string>): unknown {
  if (renamed.size === 0) return value;
  if (typeof value === "string") return renamed.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remapIds(v, renamed));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, remapIds(v, renamed)]));
  return value;
}

/**
 * Restores the file's history into the new event the import just made, after its projects and reviews. The published
 * ranking goes last: from then on the database freezes what it rests on (0017_published_inserts.sql).
 */
export function restoreHistory(tx: Tx, file: History, ctx: RestoreContext, renames: Map<string, string>, noteRename: (kind: string, from: string, to: string) => void): RestoredHistory {
  const { eventId, by } = ctx;
  const out: RestoredHistory = { prizes: [], merges: [], decisions: [], comparisons: [], ballots: [], comments: [] };
  const projectHere = (fileId: string) => (ctx.imported.has(fileId) ? ctx.projectOf.get(fileId)! : null);
  const rename = (kind: string) => (from: string, to: string) => {
    noteRename(kind, from, to);
    renames.set(from, to);
  };

  // Prizes, in the file's order
  (file.prizes ?? []).forEach((p, position) => {
    const prizeId = freeId(tx, prizes, p.id, eventId, "prize", rename("prize"));
    ctx.bump("prizes", tx.insert(prizes).values({ id: prizeId, eventId, name: p.name, description: p.description, position }).onConflictDoNothing().run().changes);
    out.prizes.push(prizeId);
  });

  // Duplicate merges: a copy counts as the one it names, as the organizer's merge left it (one level, never itself)
  const mergedInto = new Map(file.projects.filter((p) => p.duplicate_of).map((p) => [p.id, p.duplicate_of!]));
  for (const [dup, keep] of mergedInto) {
    const dupHere = projectHere(dup);
    const keepHere = projectHere(keep);
    if (!dupHere || !keepHere || dup === keep || mergedInto.has(keep)) {
      ctx.skip("merge", dup, !dupHere || !keepHere ? `a project of the merge is not in this file (${!dupHere ? dup : keep})` : "a merge names a copy that is itself merged, or the project itself");
      continue;
    }
    tx.update(projects).set({ duplicateOf: keepHere }).where(and(eq(projects.id, dupHere), eq(projects.eventId, eventId))).run();
    out.merges.push({ duplicate: dupHere, into: keepHere });
  }

  // The organizer's rulings on judges, in order, each with its reason; a later one may have replaced an earlier
  for (const o of file.decisions?.judges ?? []) {
    const judge = ctx.accountOf.get(o.judge);
    if (!judge) {
      ctx.skip("decision", o.id, `unknown judge ${o.judge}`);
      continue;
    }
    const overrideId = freeId(tx, judgeOverrides, o.id, eventId, "decision", rename("decision"));
    ctx.bump(
      "judgeOverrides",
      tx
        .insert(judgeOverrides)
        .values({ id: overrideId, eventId, judgeUserId: judge, mode: o.mode, reason: o.reason, createdAt: o.at, createdBy: by, revokedAt: o.revoked_at ?? null, revokedBy: o.revoked_at ? by : null })
        .onConflictDoNothing()
        .run().changes,
    );
    out.decisions.push(overrideId);
  }

  // The rulings kept with the event's settings: pairs that are not duplicates, under-reviewed projects published as
  // they are, and the dated changes the results and the count show. Project ids become this event's.
  const d = file.decisions;
  if (d) {
    const settings = tx.select({ settings: events.settings }).from(events).where(eq(events.id, eventId)).get()!.settings;
    const next: EventSettings = { ...settings };
    const pairs = d.not_duplicates.flatMap((p) => {
      const [a, b] = p.split("|") as [string, string];
      const ah = projectHere(a);
      const bh = projectHere(b);
      if (!ah || !bh) {
        ctx.skip("decision", p, "a project of the pair is not in this file");
        return [];
      }
      return [[ah, bh].sort().join("|")];
    });
    const accepted = d.accepted_under_reviewed.flatMap((p) => {
      const here = projectHere(p);
      if (!here) ctx.skip("decision", p, `unknown project ${p}`);
      return here ? [here] : [];
    });
    if (pairs.length) next.notDuplicates = [...new Set(pairs)].sort();
    if (accepted.length) next.acceptedUnderReviewed = [...new Set(accepted)].sort();
    if (d.weight_changes.length) next.weightChanges = d.weight_changes as EventSettings["weightChanges"];
    if (d.vote_rule_changes.length) next.voteRuleChanges = d.vote_rule_changes as EventSettings["voteRuleChanges"];
    if (d.vote_count_changes.length) next.voteCountChanges = remapIds(d.vote_count_changes, ctx.projectOf) as EventSettings["voteCountChanges"];
    // track moves live in the audit log: this import's row carries them (db/track-moves.ts reads them there)
    const moves = d.track_moves.flatMap((m) => {
      const project = projectHere(m.project);
      const from = ctx.trackOf.get(m.from);
      const to = ctx.trackOf.get(m.to);
      if (!project || !from || !to) {
        ctx.skip("decision", `${m.project}:${m.from}>${m.to}`, !project ? `unknown project ${m.project}` : `unknown track ${!from ? m.from : m.to}`);
        return [];
      }
      return [{ projectId: project, fromTrackId: from, toTrackId: to, reason: m.reason, at: m.at }];
    });
    if (moves.length) out.trackMoves = moves;
    const added = pairs.length + accepted.length + d.weight_changes.length + d.vote_rule_changes.length + d.vote_count_changes.length;
    if (added) {
      tx.update(events).set({ settings: next }).where(eq(events.id, eventId)).run();
      out.decisions.push(...pairs.map((p) => `not_duplicate:${p}`), ...accepted.map((p) => `accepted_under_reviewed:${p}`));
      if (d.weight_changes.length) out.decisions.push(`weight_changes:${d.weight_changes.length}`);
      if (d.vote_rule_changes.length) out.decisions.push(`vote_rule_changes:${d.vote_rule_changes.length}`);
      if (d.vote_count_changes.length) out.decisions.push(`vote_count_changes:${d.vote_count_changes.length}`);
    }
  }

  // Pairwise answers, taken-back ones included, each between two of the file's projects in the track it names. An
  // answer keeps its own track: a project moved to another track later (a move the file's track_moves record) still
  // has its answers from the old one, which the live engine counts only while both projects share a track, as it does
  // on the old portal.
  const tracksOf = new Map<string, Set<string>>();
  const wasIn = (project: string, track: string) => tracksOf.set(project, (tracksOf.get(project) ?? new Set<string>()).add(track));
  for (const [project, track] of ctx.trackOfProject) wasIn(project, track);
  for (const m of file.decisions?.track_moves ?? []) {
    wasIn(m.project, m.from);
    wasIn(m.project, m.to);
  }
  const open = new Set<string>();
  for (const c of file.comparisons ?? []) {
    const judge = ctx.accountOf.get(c.judge);
    const track = ctx.trackOf.get(c.track);
    const left = projectHere(c.left);
    const right = projectHere(c.right);
    const why = !judge
      ? `unknown judge ${c.judge}`
      : !track
        ? `unknown track ${c.track}`
        : !left || !right
          ? `unknown project ${!left ? c.left : c.right}`
          : c.left === c.right || (c.new !== c.left && c.new !== c.right)
            ? "an answer compares two different projects, one of them the one being placed"
            : !tracksOf.get(c.left)?.has(c.track) || !tracksOf.get(c.right)?.has(c.track)
              ? `both projects must be in track ${c.track}, now or before a track move the file records`
              : null;
    if (why) {
      ctx.skip("comparison", c.id, why);
      continue;
    }
    const key = `${judge}|${left}|${right}`;
    if (!c.taken_back_at && open.has(key)) {
      ctx.skip("comparison", c.id, "a second answer the judge had not taken back, for the same pair");
      continue;
    }
    if (!c.taken_back_at) open.add(key);
    const answerId = freeId(tx, comparisons, c.id, eventId, "pairwise answer", rename("comparison"));
    ctx.bump(
      "comparisons",
      tx
        .insert(comparisons)
        .values({
          id: answerId,
          eventId,
          judgeUserId: judge!,
          trackId: track!,
          leftProjectId: left!,
          rightProjectId: right!,
          newProjectId: c.new === c.left ? left! : right!,
          outcome: c.answer,
          createdAt: c.at,
          voidedAt: c.taken_back_at ?? null,
        })
        .onConflictDoNothing()
        .run().changes,
    );
    out.comparisons.push(answerId);
  }

  // Community ballots: the voter as the portal knew them (an account and a listed address by the address; an open
  // link's voter by nothing), their picks, and a ballot set aside with its reason. A listed or link voter gets a new
  // link secret nobody holds: the old portal's links do not open ballots here (the organizers send new ones).
  const seenPerson = new Set<string>();
  for (const b of file.ballots ?? []) {
    let userId: string | null = null;
    let email: string | null = null;
    if (b.voter.kind === "account") {
      userId = ctx.userFor(b.voter.email);
      if (!userId) {
        ctx.skip("ballot", b.id, `no account can be made for ${b.voter.email}`);
        continue;
      }
    } else if (b.voter.kind === "listed") email = b.voter.email;
    const person = userId ? `u:${userId}` : email ? `e:${email}` : null;
    if (person && seenPerson.has(person)) {
      ctx.skip("ballot", b.id, "a second ballot for the same person");
      continue;
    }
    if (person) seenPerson.add(person);
    const voterId = freeId(tx, voters, b.id, eventId, "ballot", rename("ballot"));
    const made = tx
        .insert(voters)
        .values({
          id: voterId,
          eventId,
          kind: b.voter.kind,
          userId,
          email,
          tokenHash: b.voter.kind === "account" ? null : sha256(newSecret(24)),
          orderSeed: b.order_seed,
          ipHash: null,
          agentHash: null,
          createdAt: b.created_at,
          lastVotedAt: b.last_voted_at ?? null,
          voidedAt: b.set_aside?.at ?? null,
          voidedBy: b.set_aside ? by : null,
          voidReason: b.set_aside?.reason ?? null,
        })
        .onConflictDoNothing()
        .run().changes;
    ctx.bump("voters", made);
    if (!made) {
      // nothing else in this new event can hold the row, so this is only a guard: picks never go to a ballot not made here
      ctx.skip("ballot", b.id, "the ballot could not be made");
      continue;
    }
    let picks = 0;
    const picked = new Set<string>();
    for (const p of b.picks) {
      const project = projectHere(p.project);
      if (!project || picked.has(project)) {
        ctx.skip("pick", `${b.id}:${p.project}`, project ? "the same project twice on one ballot" : `unknown project ${p.project}`);
        continue;
      }
      picked.add(project);
      ctx.bump("votes", tx.insert(votes).values({ voterId, projectId: project, createdAt: p.at }).onConflictDoNothing().run().changes);
      picks++;
    }
    out.ballots.push({ voter: voterId, picks });
  }
  if (file.ballots_sealed) {
    ctx.skip(
      "ballots",
      eventId,
      `${plural(file.ballots_sealed, "ballot was", "ballots were")} sealed in this file (voting had not closed when it was made), so ${file.ballots_sealed === 1 ? "it" : "they"} did not move; export the event again after voting closes to bring them`,
    );
  }

  // Comments, by their author's address, hidden ones still hidden with their reason
  for (const c of file.comments ?? []) {
    const project = projectHere(c.project);
    const author = project ? ctx.userFor(c.author, c.author_name) : null;
    if (!project || !author) {
      ctx.skip("comment", c.id, !project ? `unknown project ${c.project}` : `no account can be made for ${c.author}`);
      continue;
    }
    const commentId = freeId(tx, comments, c.id, eventId, "comment", rename("comment"));
    ctx.bump(
      "comments",
      tx
        .insert(comments)
        .values({
          id: commentId,
          eventId,
          projectId: project,
          userId: author,
          body: c.body,
          createdAt: c.at,
          hiddenAt: c.hidden?.at ?? null,
          hiddenBy: c.hidden ? by : null,
          hiddenReason: c.hidden?.reason ?? null,
        })
        .onConflictDoNothing()
        .run().changes,
    );
    out.comments.push(commentId);
  }

  // The published ranking, as it was stored when it was published (never worked out again here), and last the
  // event's publication: the run's rows first, since the database freezes additions once it is set.
  const pub = file.published;
  if (pub) {
    const runId = freeId(tx, normalizationRuns, pub.run.id, eventId, "published run", rename("run"));
    ctx.bump(
      "normalizationRuns",
      tx
        .insert(normalizationRuns)
        .values({ id: runId, eventId, method: pub.run.method, params: remapIds(pub.run.params, renames) as Record<string, unknown>, computedAt: pub.run.computed_at, computedBy: by })
        .onConflictDoNothing()
        .run().changes,
    );
    for (const r of pub.scores) {
      const project = projectHere(r.project);
      if (!project) {
        ctx.skip("published", r.project, `unknown project ${r.project}`);
        continue;
      }
      ctx.bump(
        "normalizedScores",
        tx
          .insert(normalizedScores)
          .values({ runId, projectId: project, n: r.n, rawMean: r.raw_mean, normalizedMean: r.normalized_mean, se: r.se, rankRaw: r.rank_raw, rankNormalized: r.rank_normalized })
          .onConflictDoNothing()
          .run().changes,
      );
    }
    const settings = tx.select({ settings: events.settings }).from(events).where(eq(events.id, eventId)).get()!.settings;
    tx.update(events).set({ resultsPublishedAt: pub.at, settings: { ...settings, publishedRunId: runId } }).where(eq(events.id, eventId)).run();
    out.published = { run: runId, at: pub.at };
  }
  return out;
}
