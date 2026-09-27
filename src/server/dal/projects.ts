import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { submissionsOpen } from "../authz";
import { getDb, type DbOrTx, type Tx } from "../db/client";
import { customAnswers, customQuestions, projects, scoreComments, teamMembers, teams, tracks } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { mutate } from "../mutate";
import { newId } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { finishedReviews, judgeSet, rubricOf, weightedTotal } from "./judging";
import { getPublishedResults } from "./normalization";
import { myTeam, type MyTeam } from "./teams";
import { issuesOf } from "./parse";

// A team's project: created and edited by its members while submissions are open,
// saved as a draft or submitted. The deadline holds in the backend: after
// submissions close every create and edit is a 403, whatever the page shows.

// Links are http(s) only: a javascript: or data: URL would reach API clients, webhook
// receivers and exports as it was typed.
const WEB_URL = { protocol: /^https?$/, message: "must be a full URL, starting with https://" };
const webUrl = z.string().trim().max(500).url(WEB_URL);

const optionalUrl = webUrl
  .or(z.literal(""))
  .optional()
  .transform((v) => (v ? v : null));

export const ProjectInput = z.object({
  title: z.string().trim().min(1, "a title is required").max(120),
  summary: z.string().trim().max(280).default(""),
  description: z.string().trim().max(20_000).default(""),
  trackId: z.string().trim().min(1, "choose a track"),
  repoUrl: optionalUrl,
  videoUrl: optionalUrl,
  liveUrl: optionalUrl,
  answers: z.record(z.string(), z.string().trim().max(5_000)).default({}),
  status: z.enum(["draft", "submitted"]).default("submitted"),
});
export type ProjectInput = z.input<typeof ProjectInput>;

export function teamOf(tx: DbOrTx, userId: string, eventId: string) {
  return tx
    .select({ id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.eventId, eventId)))
    .get();
}

function parse(body: unknown) {
  const parsed = ProjectInput.safeParse(body);
  if (!parsed.success) throw new ValidationError("The project is not valid.", issuesOf(parsed.error));
  return parsed.data;
}

/** Checks that only matter for a submission (a draft may be incomplete). */
function assertSubmittable(tx: Tx, eventId: string, input: z.output<typeof ProjectInput>) {
  const missing: Record<string, string[]> = {};
  if (!input.summary) missing.summary = ["a one-line summary is required to submit"];
  const required = tx
    .select({ id: customQuestions.id, label: customQuestions.label })
    .from(customQuestions)
    .where(and(eq(customQuestions.eventId, eventId), eq(customQuestions.required, true)))
    .all();
  for (const q of required) if (!input.answers[q.id]) missing[`answers.${q.id}`] = [`"${q.label}" is required to submit`];
  if (Object.keys(missing).length) throw new ValidationError("Some fields are needed before submitting.", missing);
}

function requireTrack(tx: Tx, trackId: string, eventId: string) {
  const track = tx
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.id, trackId), eq(tracks.eventId, eventId)))
    .get();
  if (!track) throw new ValidationError("The project is not valid.", { trackId: ["not a track of this event"] });
}

function writeAnswers(tx: Tx, projectId: string, eventId: string, answers: Record<string, string>) {
  const ids = Object.keys(answers);
  if (ids.length === 0) return;
  const known = new Map(
    tx
      .select({ id: customQuestions.id, type: customQuestions.type })
      .from(customQuestions)
      .where(and(eq(customQuestions.eventId, eventId), inArray(customQuestions.id, ids)))
      .all()
      .map((q) => [q.id, q.type]),
  );
  const notLinks = Object.entries(answers).filter(([id, value]) => known.get(id) === "url" && value && !webUrl.safeParse(value).success);
  if (notLinks.length) throw new ValidationError("Check the fields.", Object.fromEntries(notLinks.map(([id]) => [`answers.${id}`, [WEB_URL.message]])));
  for (const [questionId, value] of Object.entries(answers)) {
    if (!known.has(questionId)) continue;
    tx.insert(customAnswers)
      .values({ projectId, questionId, value })
      .onConflictDoUpdate({ target: [customAnswers.projectId, customAnswers.questionId], set: { value } })
      .run();
  }
}

/**
 * Create the actor's team project. Refusals come first, in this order: no session
 * (401), not on a team in this event (403), submissions closed (403). Only then is
 * the body validated (422), so a closed event refuses whatever is sent.
 */
export function createProject(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  let event: EventRow;
  let team: { id: string; name: string } | undefined;
  return mutate({
    actor,
    action: "project.create",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      team = actor ? teamOf(tx, actor.userId, event.id) : undefined;
      return { kind: "team_work", event: eventFacts(event), onTeam: Boolean(team) };
    },
    run: (tx) => {
      const input = parse(body);
      const t = team!;
      const existing = tx.select({ id: projects.id }).from(projects).where(eq(projects.teamId, t.id)).get();
      if (existing) {
        throw new ConflictError("team_has_project", `Team ${t.name} already has project ${existing.id}; edit it instead.`);
      }
      requireTrack(tx, input.trackId, event.id);
      if (input.status === "submitted") assertSubmittable(tx, event.id, input);
      const now = new Date().toISOString();
      const row = {
        id: newId("prj"),
        eventId: event.id,
        teamId: t.id,
        trackId: input.trackId,
        title: input.title,
        summary: input.summary,
        description: input.description,
        repoUrl: input.repoUrl,
        videoUrl: input.videoUrl,
        liveUrl: input.liveUrl,
        status: input.status,
        submittedAt: input.status === "submitted" ? now : null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(projects).values(row).run();
      writeAnswers(tx, row.id, event.id, input.answers);
      return {
        result: row,
        audit: {
          action: input.status === "submitted" ? "project.submit" : "project.create",
          eventId: event.id,
          targetType: "project",
          targetId: row.id,
          after: { title: row.title, trackId: row.trackId, teamId: row.teamId, status: row.status },
        },
      };
    },
  });
}

const EDITABLE = ["title", "summary", "description", "trackId", "repoUrl", "videoUrl", "liveUrl", "status"] as const;

/**
 * Edit (and optionally submit) a project. Only its team's members, and only while
 * submissions are open. A submitted project stays submitted: "draft" in the body
 * keeps the old status. The audit row records exactly the fields that changed.
 */
export function updateProject(actor: Actor | null, projectId: string, body: unknown) {
  let project: typeof projects.$inferSelect;
  return mutate({
    actor,
    action: "project.edit",
    load: (tx) => {
      const p = tx.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!p) throw new NotFoundError("Project");
      project = p;
      const event = requireEvent(tx, p.eventId);
      const onTeam = actor
        ? Boolean(
            tx
              .select({ t: teamMembers.teamId })
              .from(teamMembers)
              .where(and(eq(teamMembers.teamId, p.teamId), eq(teamMembers.userId, actor.userId)))
              .get(),
          )
        : false;
      return { kind: "team_work", event: eventFacts(event), onTeam };
    },
    run: (tx) => {
      const input = parse(body);
      requireTrack(tx, input.trackId, project.eventId);
      const status = project.status === "submitted" ? "submitted" : input.status;
      if (status === "submitted") assertSubmittable(tx, project.eventId, input);
      const now = new Date().toISOString();
      const next = {
        title: input.title,
        summary: input.summary,
        description: input.description,
        trackId: input.trackId,
        repoUrl: input.repoUrl,
        videoUrl: input.videoUrl,
        liveUrl: input.liveUrl,
        status,
      };
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const k of EDITABLE) {
        if (project[k] !== next[k]) {
          before[k] = project[k];
          after[k] = next[k];
        }
      }
      const submittedAt = project.submittedAt ?? (status === "submitted" ? now : null);
      tx.update(projects)
        .set({ ...next, submittedAt, updatedAt: now })
        .where(eq(projects.id, project.id))
        .run();
      writeAnswers(tx, project.id, project.eventId, input.answers);
      const justSubmitted = project.status === "draft" && status === "submitted";
      return {
        result: { id: project.id, status, submittedAt, updatedAt: now },
        audit: {
          action: justSubmitted ? "project.submit" : "project.update",
          eventId: project.eventId,
          targetType: "project",
          targetId: project.id,
          before,
          after,
        },
      };
    },
  });
}

export type Question = { id: string; label: string; help: string; type: "text" | "longtext" | "url"; required: boolean };

export type MyWork = {
  event: EventRow;
  open: boolean;
  tracks: { id: string; name: string }[];
  questions: Question[];
  team: MyTeam | null;
  project: (typeof projects.$inferSelect & { answers: Record<string, string> }) | null;
  /** after results are published: the team's place, score and every review, judges unnamed */
  feedback: TeamFeedback | null;
};

export type TeamFeedback = {
  place: number | null;
  score: number | null;
  /** one standard error of the score */
  se: number | null;
  trackName: string;
  reviews: { values: { label: string; value: number }[]; total: number; feedback: string; counted: boolean }[];
};

/** The published outcome for one project, for its own team. DAL-internal: the caller checks membership. */
function teamFeedback(db: DbOrTx, event: EventRow, projectId: string): TeamFeedback | null {
  if (!event.resultsPublishedAt) return null;
  const published = getPublishedResults(event.id);
  if (!published.published) return null;
  const track = published.tracks.find((t) => t.rows.some((r) => r.projectId === projectId));
  const row = track?.rows.find((r) => r.projectId === projectId);
  const criteria = rubricOf(db, event.id);
  const merged = new Set([projectId, ...db.select({ id: projects.id }).from(projects).where(eq(projects.duplicateOf, projectId)).all().map((x) => x.id)]);
  const excluded = new Set(judgeSet(db, event.id).excluded);
  const reviews = finishedReviews(db, event.id, criteria).filter((r) => merged.has(r.projectId));
  const notes = reviews.length
    ? new Map(
        db
          .select({ scoreId: scoreComments.scoreId, feedback: scoreComments.feedback })
          .from(scoreComments)
          .where(inArray(scoreComments.scoreId, reviews.map((r) => r.scoreId)))
          .all()
          .map((c) => [c.scoreId, c.feedback]),
      )
    : new Map<string, string>();
  return {
    place: row?.place ?? null,
    score: row?.score ?? null,
    se: row?.se ?? null,
    trackName: track?.name ?? "",
    reviews: reviews.map((r) => ({
      values: criteria.map((c, i) => ({ label: c.label, value: r.values[i]! })),
      total: weightedTotal(criteria, r.values),
      feedback: notes.get(r.scoreId) ?? "",
      counted: !excluded.has(r.judgeId),
    })),
  };
}

/** Everything the "my project" page needs for the signed-in person in one event. */
export function getMyWork(actor: Actor, eventIdOrSlug: string): MyWork {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const team = myTeam(db, actor, event.id);
  const project = team?.projectId ? db.select().from(projects).where(eq(projects.id, team.projectId)).get() : undefined;
  const answers = project
    ? Object.fromEntries(
        db
          .select({ q: customAnswers.questionId, v: customAnswers.value })
          .from(customAnswers)
          .where(eq(customAnswers.projectId, project.id))
          .all()
          .map((a) => [a.q, a.v]),
      )
    : {};
  return {
    event,
    open: submissionsOpen(eventFacts(event), new Date()),
    tracks: db
      .select({ id: tracks.id, name: tracks.name })
      .from(tracks)
      .where(eq(tracks.eventId, event.id))
      .orderBy(asc(tracks.position))
      .all(),
    questions: eventQuestions(db, event.id),
    team,
    project: project ? { ...project, answers } : null,
    feedback: project && project.status === "submitted" ? teamFeedback(db, event, project.id) : null,
  };
}

export function eventQuestions(db: DbOrTx, eventId: string): Question[] {
  return db
    .select({
      id: customQuestions.id,
      label: customQuestions.label,
      help: customQuestions.help,
      type: customQuestions.type,
      required: customQuestions.required,
    })
    .from(customQuestions)
    .where(eq(customQuestions.eventId, eventId))
    .orderBy(asc(customQuestions.position))
    .all();
}

export type PublicProject = {
  id: string;
  title: string;
  summary: string;
  description: string;
  repoUrl: string | null;
  videoUrl: string | null;
  liveUrl: string | null;
  submittedAt: string | null;
  team: { name: string; members: number };
  track: { id: string; name: string };
  answers: { label: string; value: string }[];
  duplicateOf: string | null;
};

/** One submitted project as the public sees it. Drafts are not public; scores never appear here. */
export function getPublicProject(eventIdOrSlug: string, projectId: string): { event: EventRow; project: PublicProject } {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const p = db
    .select({
      id: projects.id,
      title: projects.title,
      summary: projects.summary,
      description: projects.description,
      repoUrl: projects.repoUrl,
      videoUrl: projects.videoUrl,
      liveUrl: projects.liveUrl,
      submittedAt: projects.submittedAt,
      status: projects.status,
      duplicateOf: projects.duplicateOf,
      teamId: teams.id,
      teamName: teams.name,
      trackId: tracks.id,
      trackName: tracks.name,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .where(and(eq(projects.id, projectId), eq(projects.eventId, event.id)))
    .get();
  if (!p || p.status !== "submitted") throw new NotFoundError("Project");
  const members = db.select({ u: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, p.teamId)).all().length;
  const answers = db
    .select({ label: customQuestions.label, value: customAnswers.value })
    .from(customAnswers)
    .innerJoin(customQuestions, eq(customQuestions.id, customAnswers.questionId))
    .where(eq(customAnswers.projectId, p.id))
    .orderBy(asc(customQuestions.position))
    .all()
    .filter((a) => a.value);
  return {
    event,
    project: {
      id: p.id,
      title: p.title,
      summary: p.summary,
      description: p.description,
      repoUrl: p.repoUrl,
      videoUrl: p.videoUrl,
      liveUrl: p.liveUrl,
      submittedAt: p.submittedAt,
      team: { name: p.teamName, members },
      track: { id: p.trackId, name: p.trackName },
      answers,
      duplicateOf: p.duplicateOf,
    },
  };
}
