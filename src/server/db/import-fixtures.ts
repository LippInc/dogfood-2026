import "server-only";
// Idempotent, non-destructive import of fixtures.json: every insert is
// INSERT OR IGNORE, so an organizer's later edits survive the next boot's import.
import fs from "node:fs";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./client";
import { appendAudit } from "../audit";
import { votedForTeam } from "../team-votes";
import { DEFAULT_MAX_TEAM_SIZE, MAX_GALLERY_IMAGES, MAX_QUESTIONS, MAX_TAGS, MAX_TAG_LENGTH, QUESTION_HELP_MAX, QUESTION_LABEL } from "../project-limits";
import { BUILTIN_CRITERIA, CRITERION_LABEL, CRITERION_PROMPT_MAX, MAX_CRITERIA, RUBRIC_IN_USE } from "../rubric-defaults";
import { ConflictError, ValidationError } from "../errors";
import { allowedModes, FIELD_MODES, PROJECT_FIELDS } from "../../lib/project-fields";
import { canonicalJson, newSecret, nowIso, sha256, slugify } from "../util";
import { atMost, dateTime, id, isIsoDateTime } from "./fixture-fields";
import { checkDates, EventDates, HistoryFields, refuseHistoryForExistingEvent, restoreHistory, settingsFromFile, type HistoryTable, type RestoredHistory } from "./import-history";
import {
  assignmentRuns,
  assignments,
  customAnswers,
  customQuestions,
  events,
  fixtureImports,
  judgeTracks,
  prizes,
  projectFields,
  projects,
  QUESTION_TYPES,
  rubricCriteria,
  scoreComments,
  scoreItems,
  scores,
  teamMembers,
  teams,
  tracks,
  userRoles,
  users,
} from "./schema";

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

export { isIsoDateTime };

/**
 * How many rows one file may bring, per list. Every row costs queries inside one transaction that holds the
 * database while it runs, so a file far past any real event is refused (422, naming the list) rather than
 * stalling the portal for everyone. Several files can add to the same event.
 */
export const IMPORT_LIMITS = { tracks: 100, judges: 1_000, teams: 2_000, members: 50, projects: 2_000, scores: 16_000 } as const;
const CRITERION_LABEL_SIZE = `must be ${CRITERION_LABEL.min} to ${CRITERION_LABEL.max} characters, as on the Rubric tab`;
const QUESTION_LABEL_SIZE = `must be ${QUESTION_LABEL.min} to ${QUESTION_LABEL.max} characters, as on the Questions tab`;

export const FixtureSchema = z.looseObject({
  event: z.looseObject({
    id,
    name: z.string().min(1),
    // stored exactly as given, never reformatted
    submissions_close: dateTime,
    // Not in the organizers' format: the portal's own export adds it when the event has one.
    description: z.string().max(20_000).optional().default(""),
    // nor are the event's other dates, which the portal's export adds when they are set
    ...EventDates,
  }),
  tracks: z.array(z.looseObject({ id, name: z.string().min(1) })).max(IMPORT_LIMITS.tracks, atMost(IMPORT_LIMITS.tracks, "tracks")),
  // Not in the organizers' format: what teams are asked for each built-in field, as the portal's
  // own export writes it when an event differs from the defaults. A field left out is the default.
  project_fields: z.partialRecord(z.enum(PROJECT_FIELDS), z.enum(FIELD_MODES)).optional(),
  // Not in the organizers' format either: the rubric as the organizers set it (labels, prompts, weights, level
  // texts, order), which the portal's export writes when it differs from what the scores' keys alone would give,
  // and the event's own questions to teams. Without them an event moved between portals would score with every
  // weight back at 1 and every label a capitalised key, and lose its questions and the teams' answers. Both keep the
  // Rubric and Questions tabs' limits (the same constants), so whatever an import brings the tab can save again.
  rubric: z
    .array(
      z.looseObject({
        key: z.string().min(1).max(80),
        label: z.string().trim().min(CRITERION_LABEL.min, CRITERION_LABEL_SIZE).max(CRITERION_LABEL.max, CRITERION_LABEL_SIZE),
        prompt: z.string().max(CRITERION_PROMPT_MAX, `must be at most ${CRITERION_PROMPT_MAX} characters, as on the Rubric tab`).optional().default(""),
        weight: z.number().positive().max(100).optional().default(1),
        anchors: z.record(z.string(), z.string().max(500)).optional().default({}),
      }),
    )
    .max(MAX_CRITERIA, `at most ${MAX_CRITERIA} criteria, as on the Rubric tab`)
    .optional(),
  questions: z
    .array(
      z.looseObject({
        id,
        label: z.string().trim().min(QUESTION_LABEL.min, QUESTION_LABEL_SIZE).max(QUESTION_LABEL.max, QUESTION_LABEL_SIZE),
        help: z.string().max(QUESTION_HELP_MAX, `must be at most ${QUESTION_HELP_MAX} characters, as on the Questions tab`).optional().default(""),
        type: z.enum(QUESTION_TYPES).optional().default("longtext"),
        required: z.boolean().optional().default(false),
      }),
    )
    .max(MAX_QUESTIONS, `at most ${MAX_QUESTIONS} questions, as on the Questions tab`)
    .optional()
    .default([]),
  judges: z.array(
    z.looseObject({
      id,
      name: z.string().min(1),
      email: z.string().trim().toLowerCase(),
      tracks: z.array(id).max(IMPORT_LIMITS.tracks, atMost(IMPORT_LIMITS.tracks, "tracks")),
    }),
  ).max(IMPORT_LIMITS.judges, atMost(IMPORT_LIMITS.judges, "judges")),
  teams: z.array(
    z.looseObject({
      id,
      name: z.string().min(1),
      members: z.array(z.string().trim().toLowerCase()).max(IMPORT_LIMITS.members, `at most ${IMPORT_LIMITS.members} members in one team`),
    }),
  ).max(IMPORT_LIMITS.teams, atMost(IMPORT_LIMITS.teams, "teams")),
  projects: z.array(
    z.looseObject({
      id,
      team: id,
      track: id,
      title: z.string().min(1),
      summary: z.string().optional().default(""),
      repo_url: z
        .literal("")
        .or(z.string().url({ protocol: /^https?$/, message: "must be a full URL, starting with https://" }))
        .optional()
        .default(""),
      // Not in the organizers' format; the portal's own fixtures.json export adds them
      // when a project has them, so they survive a move between portals.
      thumbnail_url: z
        .literal("")
        .or(z.string().url({ protocol: /^https?$/, message: "must be a full URL, starting with https://" }))
        .optional()
        .default(""),
      gallery_urls: z
        .array(z.string().url({ protocol: /^https?$/, message: "must be a full URL, starting with https://" }))
        .max(MAX_GALLERY_IMAGES)
        .optional()
        .default([]),
      tags: z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS).optional().default([]),
      description: z.string().max(20_000).optional().default(""),
      video_url: z.literal("").or(z.string().url({ protocol: /^https?$/, message: "must be a full URL, starting with https://" })).optional().default(""),
      live_url: z.literal("").or(z.string().url({ protocol: /^https?$/, message: "must be a full URL, starting with https://" })).optional().default(""),
      /** the team's answers to the event's questions, by question id */
      answers: z.record(z.string(), z.string().max(5_000)).optional().default({}),
      /** the organizer's duplicate merge: this copy counts as the project it names (a new event's file only) */
      duplicate_of: id.optional(),
      submitted_at: dateTime,
    }),
  ).max(IMPORT_LIMITS.projects, atMost(IMPORT_LIMITS.projects, "projects")),
  scores: z.array(
    z.looseObject({
      judge: id,
      project: id,
      // a missing key or null means "not scored"; it never becomes a zero
      criteria: z.record(z.string(), z.number().int().nullable()),
      comment: z.string().optional(),
      // Not in the organizers' format: the judge's note to the organizers only, and when the review was finished
      // (a new event's file; a review brought into an event that is here is finished at the import, as before)
      private_note: z.string().max(4_000).optional(),
      submitted_at: dateTime.optional(),
    }),
  ).max(IMPORT_LIMITS.scores, atMost(IMPORT_LIMITS.scores, "reviews")),
  // Not in the organizers' format: the rest of what an event is, which the portal's own export adds (import-history.ts)
  ...HistoryFields,
}).superRefine((f, ctx) => checkDates(f.event, (path, message) => ctx.addIssue({ code: "custom", path: ["event", path], message })));

export type Fixture = z.infer<typeof FixtureSchema>;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

type TableKey =
  | "events"
  | "tracks"
  | "projectFields"
  | "rubricCriteria"
  | "users"
  | "userRoles"
  | "judgeTracks"
  | "teams"
  | "teamMembers"
  | "projects"
  | "assignmentRuns"
  | "assignments"
  | "scores"
  | "scoreItems"
  | "scoreComments"
  | "customQuestions"
  | "customAnswers"
  | HistoryTable;

function emptyCounts(): Record<TableKey, number> {
  return {
    events: 0,
    tracks: 0,
    projectFields: 0,
    rubricCriteria: 0,
    users: 0,
    userRoles: 0,
    judgeTracks: 0,
    teams: 0,
    teamMembers: 0,
    projects: 0,
    assignmentRuns: 0,
    assignments: 0,
    scores: 0,
    scoreItems: 0,
    scoreComments: 0,
    customQuestions: 0,
    customAnswers: 0,
    prizes: 0,
    judgeOverrides: 0,
    comparisons: 0,
    voters: 0,
    votes: 0,
    comments: 0,
    normalizationRuns: 0,
    normalizedScores: 0,
  };
}

export type Skipped = { kind: string; id: string; reason: string };

export type ImportReport = {
  eventId: string;
  inserted: Record<TableKey, number>;
  existing: Record<TableKey, number>;
  skipped: Skipped[];
  /** score ids whose judge is a member of the scored project's team */
  conflicts: string[];
  /** file ids another event already used, and the ids this event's rows got instead */
  renamed: { kind: "track" | "team" | "project" | "judge" | "question" | "prize" | "decision" | "comparison" | "ballot" | "comment" | "run"; from: string; to: string }[];
  /** set when the event is new and the web address its name gives was taken by another event */
  slug?: { wanted: string; used: string };
  /**
   * What this import added that judging rests on, one entry each, for its audit row: the accounts it
   * made judges of the event, and every review it brought in or added to (the judge's account, the
   * project, whether the review is finished once this import is done, the scores and feedback it added).
   */
  added: { judges: string[]; reviews: ImportedReview[]; judgeTracks: { judge: string; track: string }[]; criteria: string[] };
  /** a new event's history the file brought (its prizes, merges, decisions, pairwise answers, ballots, comments and published ranking), by id */
  restored?: RestoredHistory;
};

export type ImportedReview = { judge: string; project: string; finished: boolean; values: Record<string, number>; feedback?: string; privateNote?: string };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Runs one idempotent insert; 1 when the row was inserted, 0 when it already existed. */
function insertOnce(query: { run(): { changes: number } }): number {
  return query.run().changes > 0 ? 1 : 0;
}

function criterionId(eventId: string, key: string): string {
  return `crit_${eventId}_${key}`;
}

/** The label a criterion gets when a file names only its key. */
export function labelFor(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function participantUserId(email: string): string {
  return `usr_${sha256(email).slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

/** Whether a fixture file with this SHA-256 was imported into this database before. */
export function importedBefore(db: Db, sha256: string): boolean {
  return db.select({ id: fixtureImports.id }).from(fixtureImports).where(eq(fixtureImports.sha256, sha256)).get() !== undefined;
}

export function importFixtures(
  db: Db,
  fixture: Fixture,
  opts: {
    source: string;
    sha256: string;
    now?: string;
    /** who imports (the audit row's actor); the system when absent */
    actor?: { userId: string; label: string };
    /** runs first inside the import's transaction: throw to refuse (the permission check) */
    gate?: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => void;
    /** runs last inside the transaction, before the audit row (e.g. make the importer an organizer) */
    after?: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0], report: ImportReport) => void;
  },
): ImportReport {
  const now = opts.now ?? nowIso();
  const eventId = fixture.event.id;
  const report: ImportReport = {
    eventId,
    inserted: emptyCounts(),
    existing: emptyCounts(),
    skipped: [],
    conflicts: [],
    renamed: [],
    added: { judges: [], reviews: [], judgeTracks: [], criteria: [] },
  };
  const bump = (table: TableKey, changes: number) => {
    if (changes > 0) report.inserted[table] += 1;
    else report.existing[table] += 1;
  };

  // One synchronous transaction: Drizzle on better-sqlite3 throws on async callbacks.
  return db.transaction((tx) => {
    opts.gate?.(tx);

    // The file's ids are its own. Here a track, team or project belongs to one event,
    // so a file id another event already holds gets this event's id as a suffix: the
    // second event gets rows of its own instead of linking to the first event's, and
    // the same file imported again finds the same renamed rows.
    const holderOf = {
      track: (id: string) => tx.select({ e: tracks.eventId }).from(tracks).where(eq(tracks.id, id)).get()?.e,
      team: (id: string) => tx.select({ e: teams.eventId }).from(teams).where(eq(teams.id, id)).get()?.e,
      project: (id: string) => tx.select({ e: projects.eventId }).from(projects).where(eq(projects.id, id)).get()?.e,
      question: (id: string) => tx.select({ e: customQuestions.eventId }).from(customQuestions).where(eq(customQuestions.id, id)).get()?.e,
    };
    const own = (kind: keyof typeof holderOf, id: string): string => {
      const holder = holderOf[kind](id);
      if (holder === undefined || holder === eventId) return id;
      const renamed = `${id}.${eventId}`;
      const again = holderOf[kind](renamed);
      if (again !== undefined && again !== eventId) {
        throw new ConflictError("id_taken", `The ${kind} ids ${id} and ${renamed} both belong to other events; give this file's ids a prefix of their own.`);
      }
      report.renamed.push({ kind, from: id, to: renamed });
      return renamed;
    };
    const ownIds = (kind: keyof typeof holderOf, ids: string[]) => new Map([...new Set(ids)].map((id) => [id, own(kind, id)]));
    const trackOf = ownIds("track", fixture.tracks.map((t) => t.id));
    const teamOf = ownIds("team", fixture.teams.map((t) => t.id));
    const projectOf = ownIds("project", fixture.projects.map((p) => p.id));
    const questionOf = ownIds("question", fixture.questions.map((q) => q.id));

    // Event. A new event whose name gives a web address another event already has gets the first free one
    // with a number after it (the report says so); an event that is here keeps its own.
    const here = tx.select({ slug: events.slug }).from(events).where(eq(events.id, eventId)).get();
    const wanted = slugify(fixture.event.name);
    let slug = here?.slug ?? wanted;
    const taken = (s: string) => tx.select({ id: events.id }).from(events).where(eq(events.slug, s)).get() !== undefined;
    if (!here && taken(slug)) {
      for (let n = 2; taken(slug); n++) slug = `${wanted.slice(0, 60 - `-${n}`.length).replace(/-+$/, "")}-${n}`;
      report.slug = { wanted, used: slug };
    }
    bump(
      "events",
      insertOnce(
        tx
          .insert(events)
          .values({
            id: eventId,
            slug,
            name: fixture.event.name,
            description: fixture.event.description,
            submissionsOpenAt: fixture.event.submissions_open ?? null,
            submissionsCloseAt: fixture.event.submissions_close,
            judgingCloseAt: fixture.event.judging_close ?? null,
            votingOpenAt: fixture.event.voting_open ?? null,
            votingCloseAt: fixture.event.voting_close ?? null,
            settings: settingsFromFile(fixture),
            createdAt: now,
          })
          .onConflictDoNothing(),
      ),
    );

    // An event that is here keeps what it is: a file never adds a ballot, a comment, a pairwise answer, a merge, a
    // decision or a published ranking to it (refused whole, 409 new_event_only; those it holds already count as
    // present), and its own dates, settings and prizes stand (a file that differs gets a skipped line saying so).
    if (here) keepExistingEvent(tx, fixture, report, projectOf);

    // Tracks (position = order in the file)
    const trackIds = new Set<string>();
    fixture.tracks.forEach((t, position) => {
      trackIds.add(t.id);
      bump(
        "tracks",
        insertOnce(
          tx
            .insert(tracks)
            .values({ id: trackOf.get(t.id)!, eventId, name: t.name, position })
            .onConflictDoNothing(),
        ),
      );
    });

    // What teams are asked: one row per field the file names. An organizer's own later choice stays
    // (insert or ignore, like every row here); a track that could not stay a track is skipped.
    for (const [field, mode] of Object.entries(fixture.project_fields ?? {})) {
      const f = field as (typeof PROJECT_FIELDS)[number];
      if (!mode || !allowedModes(f, fixture.tracks.length).includes(mode)) {
        report.skipped.push({
          kind: "projectField",
          id: f,
          reason:
            mode === "optional"
              ? "a track cannot be optional: every project needs one"
              : `a track can be hidden only in an event with one track (the file has ${fixture.tracks.length})`,
        });
        continue;
      }
      bump("projectFields", insertOnce(tx.insert(projectFields).values({ eventId, field: f, mode }).onConflictDoNothing()));
    }

    // Rubric criteria: the file's rubric first, in its order, when it has one; then one row per other key the
    // scores use, in first-seen order, with the built-in texts and weight 1
    const given = new Map((fixture.rubric ?? []).map((c) => [c.key, c]));
    const criteriaKeys: string[] = [...given.keys()];
    for (const s of fixture.scores) {
      for (const key of Object.keys(s.criteria)) {
        if (!criteriaKeys.includes(key)) criteriaKeys.push(key);
      }
    }
    // An event that is here keeps its rubric the way the Rubric tab does (saveRubric): once judges have scored,
    // the set of criteria is fixed, so a file that would add one (through its rubric or its reviews' scores) or
    // whose rubric leaves one out is refused whole; a new criterion would stop every finished review counting.
    // Before the first score new criteria come in, held to the tab's limits. Labels, prompts and weights of the
    // criteria here stay the event's own (a weight change after scoring needs a reason, given on the tab).
    let adding: string[] = []; // keys new to an event that is here: they go after its own criteria
    let firstFree = 0;
    if (here) {
      const present = tx
        .select({ key: rubricCriteria.key, label: rubricCriteria.label, prompt: rubricCriteria.prompt, weight: rubricCriteria.weight, position: rubricCriteria.position })
        .from(rubricCriteria)
        .where(eq(rubricCriteria.eventId, eventId))
        .all();
      const known = new Set(present.map((c) => c.key));
      adding = criteriaKeys.filter((k) => !known.has(k));
      firstFree = Math.max(-1, ...present.map((c) => c.position)) + 1;
      const leavesOut = fixture.rubric !== undefined && present.some((c) => !given.has(c.key));
      const scored =
        tx
          .select({ n: sql<number>`count(*)` })
          .from(scoreItems)
          .innerJoin(rubricCriteria, eq(rubricCriteria.id, scoreItems.criterionId))
          .where(eq(rubricCriteria.eventId, eventId))
          .get()!.n > 0;
      if (scored && (adding.length > 0 || leavesOut)) throw new ConflictError("rubric_in_use", RUBRIC_IN_USE);
      checkNewCriteria(present, adding, (key) => given.get(key)?.label ?? labelFor(key));
      report.added.criteria.push(...adding);
      for (const c of present) {
        const theirs = given.get(c.key);
        if (theirs && (theirs.label !== c.label || theirs.prompt !== c.prompt || Math.abs(theirs.weight - c.weight) > 1e-9)) {
          report.skipped.push({
            kind: "criterion",
            id: c.key,
            reason: "this event's own label, prompt and weight stay; change them on its Rubric tab (after the first score a weight change needs a reason there)",
          });
        } else if (fixture.rubric !== undefined && !theirs) {
          report.skipped.push({ kind: "criterion", id: c.key, reason: "not in the file's rubric; an import never removes a criterion" });
        }
      }
    }
    if (!here) checkNewCriteria([], criteriaKeys, (key) => given.get(key)?.label ?? labelFor(key));
    criteriaKeys.forEach((key, position) => {
      const own = given.get(key);
      const builtin = own ? { prompt: own.prompt, anchors: own.anchors } : (BUILTIN_CRITERIA[key] ?? { prompt: "", anchors: {} });
      bump(
        "rubricCriteria",
        insertOnce(
          tx
            .insert(rubricCriteria)
            .values({
              id: criterionId(eventId, key),
              eventId,
              key,
              label: own?.label ?? labelFor(key),
              prompt: builtin.prompt,
              weight: own?.weight ?? 1,
              scaleMin: 1,
              scaleMax: 5,
              anchors: builtin.anchors,
              position: here ? firstFree + adding.indexOf(key) : position,
            })
            .onConflictDoNothing(),
        ),
      );
    });
    // The event's criteria as they now stand, by key: a criterion made on the Rubric tab has an id of its own, and a
    // review is finished only with a score for every criterion the event has, not only for those the file names.
    const criterionOf = new Map(
      tx
        .select({ key: rubricCriteria.key, id: rubricCriteria.id })
        .from(rubricCriteria)
        .where(eq(rubricCriteria.eventId, eventId))
        .orderBy(asc(rubricCriteria.position), asc(rubricCriteria.key))
        .all()
        .map((c) => [c.key, c.id]),
    );
    const eventKeys = [...criterionOf.keys()];

    // Judges: a user row, a judge role, and one track claim per listed track
    const judgeByEmail = new Map<string, string>(); // email -> the account that judges
    const judgeEmailById = new Map<string, string>(); // judges whose user row is present
    const accountOf = new Map<string, string>(); // the file's judge id -> the account's user id
    for (const j of fixture.judges) {
      // A file id that is another person's account is never linked to this judge: the
      // judge gets an account of their own, named from the email as team members' are.
      const holder = tx.select({ email: users.email }).from(users).where(eq(users.id, j.id)).get();
      const idTaken = holder !== undefined && holder.email.toLowerCase() !== j.email.toLowerCase();
      const wanted = idTaken ? participantUserId(j.email) : j.id;
      const changes = insertOnce(
        tx
          .insert(users)
          .values({
            id: wanted,
            email: j.email,
            name: j.name,
            passwordHash: null,
            isAdmin: false,
            createdAt: now,
          })
          .onConflictDoNothing(),
      );
      bump("users", changes);
      let userId = wanted;
      if (changes === 0 && !tx.select({ id: users.id }).from(users).where(eq(users.id, wanted)).get()) {
        // The email has an account under another id (the same person in another
        // event, or someone who signed up): never invent a second account, use that one.
        const present = tx.select({ id: users.id }).from(users).where(eq(users.email, j.email)).get();
        if (!present) {
          report.skipped.push({ kind: "judge", id: j.id, reason: `user ${j.id} could not be created` });
          continue;
        }
        userId = present.id;
      }
      if (idTaken) report.renamed.push({ kind: "judge", from: j.id, to: userId });
      accountOf.set(j.id, userId);
      judgeByEmail.set(j.email, userId);
      judgeEmailById.set(j.id, j.email);
      const madeJudge = insertOnce(
        tx
          .insert(userRoles)
          .values({ userId, eventId, role: "judge", createdAt: now })
          .onConflictDoNothing(),
      );
      bump("userRoles", madeJudge);
      if (madeJudge) report.added.judges.push(userId);
      for (const trackId of j.tracks) {
        if (!trackIds.has(trackId)) {
          report.skipped.push({
            kind: "judgeTrack",
            id: `${j.id}:${trackId}`,
            reason: `unknown track ${trackId}`,
          });
          continue;
        }
        const granted = insertOnce(
          tx
            .insert(judgeTracks)
            .values({ judgeUserId: userId, eventId, trackId: trackOf.get(trackId)! })
            .onConflictDoNothing(),
        );
        bump("judgeTracks", granted);
        // a track reaches every project in it, so each grant is named, like the judges and reviews
        if (granted) report.added.judgeTracks.push({ judge: userId, track: trackOf.get(trackId)! });
      }
    }

    // What this import adds that the forms' team rules govern, checked below for an event that was here already
    const added = {
      members: [] as { file: string; team: string; user: string; email: string }[],
      projects: [] as { file: string; id: string; team: string }[],
      assignments: [] as { file: string; judge: string; project: string }[],
    };

    // Teams
    const teamIds = new Set<string>();
    const teamMemberEmails = new Map<string, Set<string>>();
    for (const t of fixture.teams) {
      teamIds.add(t.id);
      teamMemberEmails.set(t.id, new Set(t.members));
      bump(
        "teams",
        insertOnce(
          tx
            .insert(teams)
            .values({ id: teamOf.get(t.id)!, eventId, name: t.name, inviteCode: newSecret(12), createdAt: now })
            .onConflictDoNothing(),
        ),
      );
    }

    // Team members: a users row unless the email is a judge's (one person, one
    // account), a participant role, and a team_members row
    for (const t of fixture.teams) {
      t.members.forEach((email, index) => {
        const judgeId = judgeByEmail.get(email);
        let userId = judgeId ?? participantUserId(email);
        if (!judgeId) {
          const changes = insertOnce(
            tx
              .insert(users)
              .values({
                id: userId,
                email,
                name: email.split("@")[0] ?? email,
                passwordHash: null,
                isAdmin: false,
                createdAt: now,
              })
              .onConflictDoNothing(),
          );
          bump("users", changes);
          if (changes === 0) {
            const present = tx.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
            if (present) userId = present.id;
          }
        }
        bump(
          "userRoles",
          insertOnce(
            tx
              .insert(userRoles)
              .values({ userId, eventId, role: "participant", createdAt: now })
              .onConflictDoNothing(),
          ),
        );
        // one team per person per event: a membership elsewhere is skipped, not thrown
        const membership = tx
          .select({ teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(and(eq(teamMembers.eventId, eventId), eq(teamMembers.userId, userId)))
          .get();
        if (membership && membership.teamId !== teamOf.get(t.id)) {
          report.skipped.push({
            kind: "teamMember",
            id: `${t.id}:${email}`,
            reason: `${email} is already on another team in this event`,
          });
          return;
        }
        const joined = insertOnce(
          tx
            .insert(teamMembers)
            .values({
              eventId,
              teamId: teamOf.get(t.id)!,
              userId,
              role: index === 0 ? "captain" : "member",
              joinedAt: now,
            })
            .onConflictDoNothing(),
        );
        bump("teamMembers", joined);
        if (joined) added.members.push({ file: t.id, team: teamOf.get(t.id)!, user: userId, email });
      });
    }

    // The event's questions to teams (answers come with each project)
    fixture.questions.forEach((q, position) => {
      bump(
        "customQuestions",
        insertOnce(
          tx
            .insert(customQuestions)
            .values({ id: questionOf.get(q.id)!, eventId, label: q.label, help: q.help, type: q.type, required: q.required, position })
            .onConflictDoNothing(),
        ),
      );
    });
    // the file's own count is held by the schema; with those an event here has, the Questions tab's limit still holds
    if (report.inserted.customQuestions > 0) {
      const asked = tx.select({ n: sql<number>`count(*)` }).from(customQuestions).where(eq(customQuestions.eventId, eventId)).get()!.n;
      if (asked > MAX_QUESTIONS) {
        throw new ValidationError(
          `With this file's ${report.inserted.customQuestions} new questions, this event would ask teams ${asked}; the Questions tab allows at most ${MAX_QUESTIONS}. Nothing was imported.`,
          { questions: [`at most ${MAX_QUESTIONS} questions`] },
        );
      }
    }

    // Projects: both rows of a duplicate submission are imported unchanged
    const projectById = new Map(fixture.projects.map((p) => [p.id, p]));
    const importedProjects = new Set<string>();
    for (const p of fixture.projects) {
      if (!teamIds.has(p.team) || !trackIds.has(p.track)) {
        report.skipped.push({
          kind: "project",
          id: p.id,
          reason: `unknown team ${p.team} or track ${p.track}`,
        });
        continue;
      }
      const created = insertOnce(
        tx
          .insert(projects)
          .values({
            id: projectOf.get(p.id)!,
            eventId,
            teamId: teamOf.get(p.team)!,
            trackId: trackOf.get(p.track)!,
            title: p.title,
            summary: p.summary,
            repoUrl: p.repo_url === "" ? null : p.repo_url,
            description: p.description,
            videoUrl: p.video_url === "" ? null : p.video_url,
            liveUrl: p.live_url === "" ? null : p.live_url,
            thumbnailUrl: p.thumbnail_url === "" ? null : p.thumbnail_url,
            galleryUrls: p.gallery_urls,
            tags: p.tags.filter((t, i) => p.tags.findIndex((u) => u.toLowerCase() === t.toLowerCase()) === i),
            status: "submitted",
            submittedAt: p.submitted_at,
            createdAt: p.submitted_at,
            updatedAt: p.submitted_at,
          })
          .onConflictDoNothing(),
      );
      bump("projects", created);
      if (created) added.projects.push({ file: p.id, id: projectOf.get(p.id)!, team: teamOf.get(p.team)! });
      importedProjects.add(p.id);
      // Answers are the team's words: they come in only with a project this import creates. A project that is here
      // already keeps its own (an answer the file gives the same counts as present); a file never writes into it.
      for (const [questionId, value] of Object.entries(p.answers)) {
        const qid = questionOf.get(questionId);
        if (!qid) {
          report.skipped.push({ kind: "answer", id: `${p.id}:${questionId}`, reason: `unknown question ${questionId}` });
          continue;
        }
        const projectId = projectOf.get(p.id)!;
        if (!created) {
          const own = tx
            .select({ value: customAnswers.value })
            .from(customAnswers)
            .where(and(eq(customAnswers.projectId, projectId), eq(customAnswers.questionId, qid)))
            .get();
          if (own?.value === value) bump("customAnswers", 0);
          else report.skipped.push({ kind: "answer", id: `${p.id}:${questionId}`, reason: "the project is here already, and its answers are its team's own: an import brings answers only with a project it creates" });
          continue;
        }
        bump("customAnswers", insertOnce(tx.insert(customAnswers).values({ projectId, questionId: qid, value }).onConflictDoNothing()));
      }
    }

    // Scores: one assignment run for the whole file, then a row per fixture score
    const runId = `run_fixture_${eventId}`;
    bump(
      "assignmentRuns",
      insertOnce(
        tx
          .insert(assignmentRuns)
          .values({
            id: runId,
            eventId,
            mode: "fixture",
            seed: 0,
            params: { source: opts.source, sha256: opts.sha256 },
            createdAt: now,
            createdBy: null,
          })
          .onConflictDoNothing(),
      ),
    );

    const seenPairs = new Set<string>();
    const judgePosition = new Map<string, number>();
    for (const s of fixture.scores) {
      const position = judgePosition.get(s.judge) ?? 0;
      judgePosition.set(s.judge, position + 1);

      const judgeEmail = judgeEmailById.get(s.judge);
      if (!judgeEmail) {
        report.skipped.push({
          kind: "score",
          id: `${s.judge}:${s.project}`,
          reason: `unknown judge ${s.judge}`,
        });
        continue;
      }
      const project = projectById.get(s.project);
      if (!project || !importedProjects.has(s.project)) {
        report.skipped.push({
          kind: "score",
          id: `${s.judge}:${s.project}`,
          reason: `unknown project ${s.project}`,
        });
        continue;
      }
      const pair = `${s.judge}|${s.project}`;
      if (seenPairs.has(pair)) {
        report.skipped.push({
          kind: "score",
          id: pair,
          reason: "second score for the same judge and project",
        });
        continue;
      }
      seenPairs.add(pair);
      const outOfRange = Object.entries(s.criteria).find(([, v]) => v !== null && (v < 1 || v > 5));
      if (outOfRange) {
        report.skipped.push({
          kind: "score",
          id: pair,
          reason: `value ${outOfRange[1]} for ${outOfRange[0]} out of range 1..5`,
        });
        continue;
      }

      const complete = eventKeys.every((k) => typeof s.criteria[k] === "number");
      const projectId = projectOf.get(s.project)!;
      // A review given out on the portal has an assignment and a score with ids of their own: the pair's rows are found
      // by judge and project after the insert-or-ignore, never assumed to carry the importer's ids (a score pointing at
      // an assignment that does not exist failed the whole import on its foreign key)
      const brought: ImportedReview = { judge: accountOf.get(s.judge)!, project: projectId, finished: complete, values: {} };
      let broughtAny = false;
      const newAssignment = insertOnce(
        tx
          .insert(assignments)
          .values({
            id: `asg_${s.judge}_${projectId}`,
            eventId,
            judgeUserId: accountOf.get(s.judge)!,
            projectId,
            runId,
            batchNo: 1,
            position,
            status: complete ? "done" : "pending",
            createdAt: now,
          })
          .onConflictDoNothing(),
      );
      bump("assignments", newAssignment);
      const found = tx
        .select({ id: assignments.id, runId: assignments.runId })
        .from(assignments)
        .where(and(eq(assignments.judgeUserId, accountOf.get(s.judge)!), eq(assignments.projectId, projectId)))
        .get();
      if (!found) {
        // the importer's id is another judge's assignment (a file judge id an earlier file gave another account)
        report.skipped.push({ kind: "score", id: pair, reason: `the review id asg_${s.judge}_${projectId} belongs to another judge's review` });
        continue;
      }
      if (found.runId !== runId) {
        // A review the portal handed out is the judge's own: an import never writes a score, a value or feedback into
        // it (a score there would count in the results under the judge's name while their assignment stays pending,
        // and their console would show values they never entered). An event's own export brings these reviews back
        // with the values they already hold, so skipping them changes nothing on a round trip.
        report.skipped.push({ kind: "score", id: pair, reason: `a review handed out on the portal (${found.id}) is the judge's own: an import never writes into it` });
        continue;
      }
      const assignmentId = found.id;
      if (newAssignment) {
        broughtAny = true;
        added.assignments.push({ file: `${s.judge} of ${s.project}`, judge: accountOf.get(s.judge)!, project: projectId });
      }

      const memberEmails = teamMemberEmails.get(project.team) ?? new Set<string>();
      const conflicted = memberEmails.has(judgeEmail);
      const finishedAt = !here && s.submitted_at ? s.submitted_at : now;
      const scoreChanges = insertOnce(
        tx
          .insert(scores)
          .values({
            id: `scr_${s.judge}_${projectId}`,
            assignmentId,
            submittedAt: complete ? finishedAt : null,
            updatedAt: complete ? finishedAt : now,
            conflicted,
          })
          .onConflictDoNothing(),
      );
      bump("scores", scoreChanges);
      const scoreId = tx.select({ id: scores.id }).from(scores).where(eq(scores.assignmentId, assignmentId)).get()?.id;
      if (!scoreId) {
        report.skipped.push({ kind: "score", id: pair, reason: `the score id scr_${s.judge}_${projectId} belongs to another judge's review` });
        continue;
      }
      if (scoreChanges) broughtAny = true;
      if (conflicted && scoreChanges > 0) report.conflicts.push(scoreId);

      for (const key of eventKeys) {
        const value = s.criteria[key];
        if (typeof value !== "number") continue; // missing or null: not scored, never a zero
        const item = insertOnce(
          tx
            .insert(scoreItems)
            .values({ scoreId, criterionId: criterionOf.get(key)!, value })
            .onConflictDoNothing(),
        );
        bump("scoreItems", item);
        if (item) {
          brought.values[key] = value;
          broughtAny = true;
        }
      }
      if (s.comment || s.private_note) {
        const comment = insertOnce(
          tx
            .insert(scoreComments)
            .values({ scoreId, feedback: s.comment ?? "", privateNote: s.private_note ?? "" })
            .onConflictDoNothing(),
        );
        bump("scoreComments", comment);
        if (comment) {
          if (s.comment) brought.feedback = s.comment;
          if (s.private_note) brought.privateNote = s.private_note;
          broughtAny = true;
        }
      }
      // A review an earlier import brought in part, that this one completes, is finished as a judge's save finishes it
      if (!newAssignment && broughtAny) finishIfComplete(tx, [...criterionOf.values()], assignmentId, scoreId, now);
      if (broughtAny) {
        // finished as the review stands after this import, not as the file has it: a file that brings only the
        // missing scores of an earlier import's review is what finished it
        brought.finished = tx.select({ status: assignments.status }).from(assignments).where(eq(assignments.id, assignmentId)).get()?.status === "done";
        report.added.reviews.push(brought);
      }
    }

    // A new event gets the rest of what it was: prizes, merges, decisions, pairwise answers, ballots, comments, and last
    // its published ranking (import-history.ts)
    if (!here) {
      const renames = new Map<string, string>([
        ...report.renamed.map((r) => [r.from, r.to] as [string, string]),
        ...[...accountOf].filter(([from, to]) => from !== to),
      ]);
      report.restored = restoreHistory(
        tx,
        fixture,
        {
          eventId,
          by: opts.actor?.userId ?? "system",
          projectOf,
          trackOf,
          accountOf,
          imported: importedProjects,
          trackOfProject: new Map(fixture.projects.map((p) => [p.id, p.track])),
          userFor: (email, name) => accountForAddress(tx, email, name, now, (changes) => bump("users", changes)),
          bump: (table, changes) => bump(table, changes),
          skip: (kind, id, reason) => report.skipped.push({ kind, id, reason }),
        },
        renames,
        (kind, from, to) => report.renamed.push({ kind: kind as ImportReport["renamed"][number]["kind"], from, to }),
      );
    }

    // An event that was here keeps the rules its forms keep (the team pages, the project form, hand assignment): a
    // team never grows past the event's size, a team has one project, a judge never gets a project whose team
    // they are on, from either side, and nobody joins a team they have a community vote for (the count leaves
    // out a member's votes for their own team, so the join would change it). A file that would break one is refused whole, naming its row. A new event's
    // file is the organizers' data as given: its conflicted reviews come in flagged (scores.conflicted).
    if (here) {
      const max = tx.select({ settings: events.settings }).from(events).where(eq(events.id, eventId)).get()!.settings.maxTeamSize ?? DEFAULT_MAX_TEAM_SIZE;
      const onTeam = (userId: string, teamId: string) =>
        tx.select({ u: teamMembers.userId }).from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))).get() !== undefined;
      for (const [teamId, file] of new Map(added.members.map((m) => [m.team, m.file]))) {
        const size = tx.select({ n: sql<number>`count(*)` }).from(teamMembers).where(eq(teamMembers.teamId, teamId)).get()!.n;
        if (size > max) {
          throw new ConflictError("team_full", `The file's team ${file} would have ${size} members; this event allows ${max} (Settings). Nothing was imported.`);
        }
      }
      for (const p of added.projects) {
        const other = tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.teamId, p.team), ne(projects.id, p.id)))
          .orderBy(asc(projects.createdAt), asc(projects.id))
          .get();
        if (other) {
          throw new ConflictError("team_has_project", `The file's project ${p.file}: its team ${p.team} already has project ${other.id}, and a team has one project. Nothing was imported.`);
        }
      }
      for (const a of added.assignments) {
        const team = tx.select({ team: projects.teamId }).from(projects).where(eq(projects.id, a.project)).get()!.team;
        if (onTeam(a.judge, team)) {
          throw new ConflictError("conflict_of_interest", `The file's review by ${a.file}: this judge is on the project's team. Nothing was imported.`);
        }
      }
      for (const m of added.members) {
        const judging = tx
          .select({ a: assignments.id })
          .from(assignments)
          .innerJoin(projects, eq(projects.id, assignments.projectId))
          .where(and(eq(projects.teamId, m.team), eq(assignments.judgeUserId, m.user), ne(assignments.status, "recused")))
          .get();
        if (judging) {
          throw new ConflictError("conflict_of_interest", `The file's team ${m.file}: ${m.email} is assigned to judge this team's project. Reassign that review first. Nothing was imported.`);
        }
        if (votedForTeam(tx, eventId, m.user, m.team)) {
          throw new ConflictError("vote_would_change", `The file's team ${m.file}: ${m.email} has a community vote for this team's project, and the count leaves out a member's votes for their own team, so adding them would change it. Nothing was imported.`);
        }
      }
    }

    // One fixture_imports row per call, even when everything was already present
    tx.insert(fixtureImports)
      .values({ source: opts.source, sha256: opts.sha256, importedAt: now, counts: report.inserted })
      .run();

    opts.after?.(tx, report);

    // Exactly one audit row, and only when this import actually inserted something; it lists the judges
    // and reviews the import added, so the log says who judged what by import, not only how many
    const total = Object.values(report.inserted).reduce((a, b) => a + b, 0);
    if (total > 0) {
      appendAudit(
        tx,
        {
          actorUserId: opts.actor?.userId ?? null,
          actorLabel: opts.actor?.label ?? "system",
          action: "fixtures.import",
          eventId,
          targetType: "event",
          targetId: eventId,
          // the judges and reviews by name, not only counted: an import can add both to an event that is judging
          after: {
            source: opts.source,
            sha256: opts.sha256,
            inserted: report.inserted,
            judges: report.added.judges,
            reviews: report.added.reviews,
            judgeTracks: report.added.judgeTracks,
            // the criteria it added to the rubric of an event that was here already (only before its first score)
            ...(report.added.criteria.length ? { criteria: report.added.criteria } : {}),
            // a new event's history, every restored row by its id (a ballot by its voter and how many picks)
            ...(report.restored ? { restored: report.restored } : {}),
          },
        },
        now,
      );
    }
    return report;
  });
}

/**
 * The criteria an import adds, held to the Rubric tab's limits (saveRubric), so the tab can save the rubric again:
 * at most MAX_CRITERIA with those the event has, each label 2 to 60 characters (a label a score's key gives, too),
 * and no two with one label. Refused whole, 422, naming the criterion.
 */
function checkNewCriteria(present: { label: string }[], keys: string[], labelOf: (key: string) => string): void {
  if (keys.length === 0) return;
  if (present.length + keys.length > MAX_CRITERIA) {
    throw new ValidationError(`A rubric has at most ${MAX_CRITERIA} criteria; with this file's, this event would have ${present.length + keys.length}.`, {
      rubric: [`at most ${MAX_CRITERIA} criteria`],
    });
  }
  const labels = new Set(present.map((c) => c.label.toLowerCase()));
  for (const key of keys) {
    const label = labelOf(key);
    if (label.length < CRITERION_LABEL.min || label.length > CRITERION_LABEL.max) {
      throw new ValidationError(`The criterion ${key.slice(0, 80)} would be called "${label.slice(0, 80)}": a criterion's label ${CRITERION_LABEL_SIZE}. Give it a rubric row with a label.`, {
        rubric: [`${key.slice(0, 80)}: the label ${CRITERION_LABEL_SIZE}`],
      });
    }
    if (labels.has(label.toLowerCase())) throw new ValidationError(`Two criteria are called "${label}".`, { rubric: [`"${label}" appears twice`] });
    labels.add(label.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

export function loadFixtureFile(file: string): { fixture: Fixture; sha256: string } {
  const text = fs.readFileSync(file, "utf8");
  const digest = sha256(text);
  return { fixture: FixtureSchema.parse(JSON.parse(text)), sha256: digest };
}

/** The account for an address: found, or made without a password as the importer makes team members' (null when neither works). */
function accountForAddress(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], email: string, name: string | undefined, now: string, counted: (changes: number) => void): string | null {
  const wanted = participantUserId(email);
  const changes = insertOnce(
    tx
      .insert(users)
      .values({ id: wanted, email, name: name ?? email.split("@")[0] ?? email, passwordHash: null, isAdmin: false, createdAt: now })
      .onConflictDoNothing(),
  );
  counted(changes);
  return tx.select({ id: users.id }).from(users).where(eq(users.email, email)).get()?.id ?? null;
}

/**
 * For an event that is here: refuses a file that would add to its history (import-history.ts), counts what it holds
 * already as present, and says in a skipped line when the file's dates, settings or prizes differ from the event's
 * own, which stand (they change on its Settings and Voting tabs, where changes after the fact need their reasons).
 */
function keepExistingEvent(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], fixture: Fixture, report: ImportReport, projectOf: Map<string, string>) {
  const eventId = fixture.event.id;
  const ev = tx.select().from(events).where(eq(events.id, eventId)).get()!;
  const present = refuseHistoryForExistingEvent(tx, fixture, eventId, { at: ev.resultsPublishedAt, runId: ev.settings.publishedRunId ?? null, settings: ev.settings }, projectOf);
  for (const [table, n] of Object.entries(present)) report.existing[table as TableKey] += n;
  const instant = (s: string | null | undefined) => (s ? Date.parse(s) : null);
  const dates: [string, string | undefined, string | null][] = [
    ["submissions_open", fixture.event.submissions_open, ev.submissionsOpenAt],
    ["judging_close", fixture.event.judging_close, ev.judgingCloseAt],
    ["voting_open", fixture.event.voting_open, ev.votingOpenAt],
    ["voting_close", fixture.event.voting_close, ev.votingCloseAt],
  ];
  const moved = dates.filter(([, file, own]) => file !== undefined && instant(file) !== instant(own)).map(([name]) => name);
  if (moved.length) report.skipped.push({ kind: "event", id: eventId, reason: `this event keeps its own dates (${moved.join(", ")}); change them on its Settings or Voting tab` });
  const given = settingsFromFile(fixture) as Record<string, unknown>;
  const own = ev.settings as Record<string, unknown>;
  const portable = (key: string, v: unknown) => {
    if (key !== "voting" || !v || typeof v !== "object") return v;
    const { linkHash: _link, ...rules } = v as Record<string, unknown>;
    return rules;
  };
  const differ = Object.keys(given).filter((k) => canonicalJson(portable(k, given[k])) !== canonicalJson(portable(k, own[k])));
  if (differ.length) report.skipped.push({ kind: "settings", id: eventId, reason: `this event keeps its own settings (${differ.join(", ")}); change them on its Settings or Voting tab` });
  if (fixture.prizes) {
    const held = tx.select({ name: prizes.name, description: prizes.description }).from(prizes).where(eq(prizes.eventId, eventId)).orderBy(asc(prizes.position), asc(prizes.id)).all();
    if (canonicalJson(held) !== canonicalJson(fixture.prizes.map((p) => ({ name: p.name, description: p.description })))) {
      report.skipped.push({ kind: "prizes", id: eventId, reason: "this event keeps its own prizes; change them on its Settings tab" });
    }
  }
}

/** A pending review whose score now has every one of the event's criteria (their ids): done, submitted now (a recused one stays). */
function finishIfComplete(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], criterionIds: string[], assignmentId: string, scoreId: string, now: string) {
  const a = tx.select({ status: assignments.status }).from(assignments).where(eq(assignments.id, assignmentId)).get();
  if (a?.status !== "pending") return;
  const scored = new Set(tx.select({ c: scoreItems.criterionId }).from(scoreItems).where(eq(scoreItems.scoreId, scoreId)).all().map((i) => i.c));
  if (criterionIds.length === 0 || !criterionIds.every((id) => scored.has(id))) return;
  tx.update(scores).set({ submittedAt: now, updatedAt: now }).where(and(eq(scores.id, scoreId), isNull(scores.submittedAt))).run();
  tx.update(assignments).set({ status: "done" }).where(eq(assignments.id, assignmentId)).run();
}
