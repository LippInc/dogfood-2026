import "server-only";
// Idempotent, non-destructive import of fixtures.json: every insert is
// INSERT OR IGNORE, so an organizer's later edits survive the next boot's import.
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./client";
import { appendAudit } from "../audit";
import { BUILTIN_CRITERIA } from "../rubric-defaults";
import { newSecret, nowIso, sha256, slugify } from "../util";
import {
  assignmentRuns,
  assignments,
  events,
  fixtureImports,
  judgeTracks,
  projects,
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

const id = z.string().min(1);

export const FixtureSchema = z.looseObject({
  event: z.looseObject({
    id,
    name: z.string().min(1),
    // stored exactly as given, never reformatted
    submissions_close: z.string().min(1),
  }),
  tracks: z.array(z.looseObject({ id, name: z.string().min(1) })),
  judges: z.array(
    z.looseObject({
      id,
      name: z.string().min(1),
      email: z.string().trim().toLowerCase(),
      tracks: z.array(id),
    }),
  ),
  teams: z.array(
    z.looseObject({
      id,
      name: z.string().min(1),
      members: z.array(z.string().trim().toLowerCase()),
    }),
  ),
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
        .max(6)
        .optional()
        .default([]),
      tags: z.array(z.string().trim().min(1).max(24)).max(8).optional().default([]),
      submitted_at: z.string().min(1),
    }),
  ),
  scores: z.array(
    z.looseObject({
      judge: id,
      project: id,
      // a missing key or null means "not scored"; it never becomes a zero
      criteria: z.record(z.string(), z.number().int().nullable()),
      comment: z.string().optional(),
    }),
  ),
});

export type Fixture = z.infer<typeof FixtureSchema>;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

type TableKey =
  | "events"
  | "tracks"
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
  | "scoreComments";

function emptyCounts(): Record<TableKey, number> {
  return {
    events: 0,
    tracks: 0,
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
  renamed: { kind: "track" | "team" | "project" | "judge"; from: string; to: string }[];
};

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

function labelFor(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function participantUserId(email: string): string {
  return `usr_${sha256(email).slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

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

    // Event
    bump(
      "events",
      insertOnce(
        tx
          .insert(events)
          .values({
            id: eventId,
            slug: slugify(fixture.event.name),
            name: fixture.event.name,
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

    // Rubric criteria: one row per distinct key, in first-seen order
    const criteriaKeys: string[] = [];
    for (const s of fixture.scores) {
      for (const key of Object.keys(s.criteria)) {
        if (!criteriaKeys.includes(key)) criteriaKeys.push(key);
      }
    }
    criteriaKeys.forEach((key, position) => {
      const builtin = BUILTIN_CRITERIA[key] ?? { prompt: "", anchors: {} };
      bump(
        "rubricCriteria",
        insertOnce(
          tx
            .insert(rubricCriteria)
            .values({
              id: criterionId(eventId, key),
              eventId,
              key,
              label: labelFor(key),
              prompt: builtin.prompt,
              weight: 1,
              scaleMin: 1,
              scaleMax: 5,
              anchors: builtin.anchors,
              position,
            })
            .onConflictDoNothing(),
        ),
      );
    });

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
      bump(
        "userRoles",
        insertOnce(
          tx
            .insert(userRoles)
            .values({ userId, eventId, role: "judge", createdAt: now })
            .onConflictDoNothing(),
        ),
      );
      for (const trackId of j.tracks) {
        if (!trackIds.has(trackId)) {
          report.skipped.push({
            kind: "judgeTrack",
            id: `${j.id}:${trackId}`,
            reason: `unknown track ${trackId}`,
          });
          continue;
        }
        bump(
          "judgeTracks",
          insertOnce(
            tx
              .insert(judgeTracks)
              .values({ judgeUserId: userId, eventId, trackId: trackOf.get(trackId)! })
              .onConflictDoNothing(),
          ),
        );
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

      const complete = criteriaKeys.every((k) => typeof s.criteria[k] === "number");
      const projectId = projectOf.get(s.project)!;
      const assignmentId = `asg_${s.judge}_${projectId}`;
      const scoreId = `scr_${s.judge}_${projectId}`;
      bump(
        "assignments",
        insertOnce(
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
        ),
      );

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
      if (conflicted && scoreChanges > 0) report.conflicts.push(scoreId);

      for (const key of criteriaKeys) {
        const value = s.criteria[key];
        if (typeof value !== "number") continue; // missing or null: not scored, never a zero
        bump(
          "scoreItems",
          insertOnce(
            tx
              .insert(scoreItems)
              .values({ scoreId, criterionId: criterionId(eventId, key), value })
              .onConflictDoNothing(),
          ),
        );
      }
      if (s.comment) {
        bump(
          "scoreComments",
          insertOnce(
            tx
              .insert(scoreComments)
              .values({ scoreId, feedback: s.comment, privateNote: "" })
              .onConflictDoNothing(),
          ),
        );
      }
    }

    // One fixture_imports row per call, even when everything was already present
    tx.insert(fixtureImports)
      .values({ source: opts.source, sha256: opts.sha256, importedAt: now, counts: report.inserted })
      .run();

    opts.after?.(tx, report);

    // Exactly one audit row, and only when this import actually inserted something
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
          after: { source: opts.source, sha256: opts.sha256, inserted: report.inserted },
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
