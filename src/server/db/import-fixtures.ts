import "server-only";
// Idempotent, non-destructive import of fixtures.json: every insert is
// INSERT OR IGNORE, so an organizer's later edits survive the next boot's import.
import fs from "node:fs";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./client";
import { appendAudit } from "../audit";
import { MAX_GALLERY_IMAGES, MAX_TAGS, MAX_TAG_LENGTH } from "../project-limits";
import { BUILTIN_CRITERIA, MAX_CRITERIA, RUBRIC_IN_USE } from "../rubric-defaults";
import { ConflictError, ValidationError } from "../errors";
import { allowedModes, FIELD_MODES, PROJECT_FIELDS } from "../../lib/project-fields";
import { newSecret, nowIso, sha256, slugify } from "../util";
import {
  assignmentRuns,
  assignments,
  customAnswers,
  customQuestions,
  events,
  fixtureImports,
  judgeTracks,
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

// Ids end up in addresses, export file names and response headers, so only a safe set of characters.
const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/, "must be 1 to 80 letters, digits, '_', '-' or '.', starting with a letter or digit");

/** An ISO 8601 date and time with its time zone, such as 2026-03-01T18:00:00Z, that is a real day. */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
export function isIsoDateTime(s: string): boolean {
  const m = ISO_DATE_TIME.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return mo >= 1 && mo <= 12 && day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}
const dateTime = z.string().refine(isIsoDateTime, "must be a date and time with its time zone, such as 2026-03-01T18:00:00Z");

/**
 * How many rows one file may bring, per list. Every row costs queries inside one transaction that holds the
 * database while it runs, so a file far past any real event is refused (422, naming the list) rather than
 * stalling the portal for everyone. Several files can add to the same event.
 */
export const IMPORT_LIMITS = { tracks: 100, judges: 1_000, teams: 2_000, members: 50, projects: 2_000, scores: 16_000 } as const;
const atMost = (n: number, what: string) => `at most ${n.toLocaleString("en")} ${what} in one file; split it into several imports`;

export const FixtureSchema = z.looseObject({
  event: z.looseObject({
    id,
    name: z.string().min(1),
    // stored exactly as given, never reformatted
    submissions_close: dateTime,
    // Not in the organizers' format: the portal's own export adds it when the event has one.
    description: z.string().max(20_000).optional().default(""),
  }),
  tracks: z.array(z.looseObject({ id, name: z.string().min(1) })).max(IMPORT_LIMITS.tracks, atMost(IMPORT_LIMITS.tracks, "tracks")),
  // Not in the organizers' format: what teams are asked for each built-in field, as the portal's
  // own export writes it when an event differs from the defaults. A field left out is the default.
  project_fields: z.partialRecord(z.enum(PROJECT_FIELDS), z.enum(FIELD_MODES)).optional(),
  // Not in the organizers' format either: the rubric as the organizers set it (labels, prompts, weights, level
  // texts, order), which the portal's export writes when it differs from what the scores' keys alone would give,
  // and the event's own questions to teams. Without them an event moved between portals would score with every
  // weight back at 1 and every label a capitalised key, and lose its questions and the teams' answers.
  rubric: z
    .array(
      z.looseObject({
        key: z.string().min(1).max(80),
        label: z.string().trim().min(1).max(80),
        prompt: z.string().max(2_000).optional().default(""),
        weight: z.number().positive().max(100).optional().default(1),
        anchors: z.record(z.string(), z.string().max(500)).optional().default({}),
      }),
    )
    .max(20)
    .optional(),
  questions: z
    .array(
      z.looseObject({
        id,
        label: z.string().trim().min(1).max(200),
        help: z.string().max(1_000).optional().default(""),
        type: z.enum(QUESTION_TYPES).optional().default("longtext"),
        required: z.boolean().optional().default(false),
      }),
    )
    .max(30)
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
    }),
  ).max(IMPORT_LIMITS.scores, atMost(IMPORT_LIMITS.scores, "reviews")),
});

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
  | "customAnswers";

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
  renamed: { kind: "track" | "team" | "project" | "judge" | "question"; from: string; to: string }[];
  /** set when the event is new and the web address its name gives was taken by another event */
  slug?: { wanted: string; used: string };
  /**
   * What this import added that judging rests on, one entry each, for its audit row: the accounts it
   * made judges of the event, and every review it brought in or added to (the judge's account, the
   * project, whether the file's review is finished, the scores and feedback it added).
   */
  added: { judges: string[]; reviews: ImportedReview[]; judgeTracks: { judge: string; track: string }[]; criteria: string[] };
};

export type ImportedReview = { judge: string; project: string; finished: boolean; values: Record<string, number>; feedback?: string };

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
        throw new Error(`The ${kind} ids ${id} and ${renamed} both belong to other events; give this file's ids a prefix of their own.`);
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
            submissionsOpenAt: null,
            submissionsCloseAt: fixture.event.submissions_close,
            createdAt: now,
          })
          .onConflictDoNothing(),
      ),
    );

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
      if (adding.length > 0) {
        if (present.length + adding.length > MAX_CRITERIA) {
          throw new ValidationError(`A rubric has at most ${MAX_CRITERIA} criteria; with this file's, this event would have ${present.length + adding.length}.`, {
            rubric: [`at most ${MAX_CRITERIA} criteria`],
          });
        }
        const labels = new Set(present.map((c) => c.label.toLowerCase()));
        for (const key of adding) {
          const label = given.get(key)?.label ?? labelFor(key);
          if (labels.has(label.toLowerCase())) throw new ValidationError(`Two criteria are called "${label}".`, { rubric: [`"${label}" appears twice`] });
          labels.add(label.toLowerCase());
        }
        report.added.criteria.push(...adding);
      }
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
        bump(
          "teamMembers",
          insertOnce(
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
          ),
        );
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
      bump(
        "projects",
        insertOnce(
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
        ),
      );
      importedProjects.add(p.id);
      for (const [questionId, value] of Object.entries(p.answers)) {
        const qid = questionOf.get(questionId);
        if (!qid) {
          report.skipped.push({ kind: "answer", id: `${p.id}:${questionId}`, reason: `unknown question ${questionId}` });
          continue;
        }
        bump("customAnswers", insertOnce(tx.insert(customAnswers).values({ projectId: projectOf.get(p.id)!, questionId: qid, value }).onConflictDoNothing()));
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
      const assignmentId = `asg_${s.judge}_${projectId}`;
      const scoreId = `scr_${s.judge}_${projectId}`;
      const brought: ImportedReview = { judge: accountOf.get(s.judge)!, project: projectId, finished: complete, values: {} };
      let broughtAny = false;
      const newAssignment = insertOnce(
        tx
          .insert(assignments)
          .values({
            id: assignmentId,
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
      if (newAssignment) broughtAny = true;

      const memberEmails = teamMemberEmails.get(project.team) ?? new Set<string>();
      const conflicted = memberEmails.has(judgeEmail);
      const scoreChanges = insertOnce(
        tx
          .insert(scores)
          .values({
            id: scoreId,
            assignmentId,
            submittedAt: complete ? now : null,
            updatedAt: now,
            conflicted,
          })
          .onConflictDoNothing(),
      );
      bump("scores", scoreChanges);
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
      if (s.comment) {
        const comment = insertOnce(
          tx
            .insert(scoreComments)
            .values({ scoreId, feedback: s.comment, privateNote: "" })
            .onConflictDoNothing(),
        );
        bump("scoreComments", comment);
        if (comment) {
          brought.feedback = s.comment;
          broughtAny = true;
        }
      }
      if (broughtAny) report.added.reviews.push(brought);
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
          },
        },
        now,
      );
    }
    return report;
  });
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

export function loadFixtureFile(file: string): { fixture: Fixture; sha256: string } {
  const text = fs.readFileSync(file, "utf8");
  const digest = sha256(text);
  return { fixture: FixtureSchema.parse(JSON.parse(text)), sha256: digest };
}
