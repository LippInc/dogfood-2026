import "server-only";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { submissionsOpen } from "../authz";
import { getDb, type DbOrTx, type Tx } from "../db/client";
import { assignments, customAnswers, customQuestions, projects, scoreComments, teamMembers, teams, tracks } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { mutate } from "../mutate";
import { derivedId, newId } from "../util";
import { eventFacts, participantEventView, requireEvent, type EventRow, type ParticipantEventView } from "./events";
import { finishedReviews, formerJudges, judgeSet, rubricOf, weightedTotal } from "./judging";
import { getPublishedResults } from "./results";
import { isSolo, myTeam, organizerChangedAfterClose, type MyTeam } from "./teams";
import { issuesOf } from "./parse";
import { discardUpload, shownElsewhere, UPLOAD_PATH } from "../uploads";
import { DEFAULT_FIELD_MODES, PROJECT_FIELDS, REQUIRED_MESSAGES, withoutHidden, type FieldModes } from "@/lib/project-fields";
import { competitionPlaces, tieDecided } from "@/lib/places";
import { fieldModes, shownTitle } from "./project-fields";
import { MAX_GALLERY_IMAGES, MAX_TAGS, MAX_TAG_LENGTH } from "../project-limits";

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

/** Tech tags are kept as typed but compared without case: "Rust" and "rust" are one tag. */
function distinctTags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((t) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export { MAX_GALLERY_IMAGES, MAX_TAGS, MAX_TAG_LENGTH };
const tagList = z
  .array(z.string().trim().min(1, "a tag cannot be empty").max(MAX_TAG_LENGTH, `a tag is at most ${MAX_TAG_LENGTH} characters`))
  .default([])
  .transform(distinctTags)
  .pipe(z.array(z.string()).max(MAX_TAGS, `at most ${MAX_TAGS} tags`));

/**
 * A project's image gallery, in the order it shows: each an image uploaded here (its /uploads/ address, which only
 * the project holding it may send back: checkGalleryUploads) or on the team's own host, http(s) only. The same
 * image twice is kept once.
 */
export const galleryList = z
  .array(
    z
      .string()
      .trim()
      .max(500)
      .refine((v) => UPLOAD_PATH.test(v) || webUrl.safeParse(v).success, WEB_URL.message),
  )
  .transform((list) => [...new Set(list)])
  .pipe(z.array(z.string()).max(MAX_GALLERY_IMAGES, `at most ${MAX_GALLERY_IMAGES} images`));

/**
 * An uploaded gallery image is added only by uploading it: its address is public on the project page, so a list that
 * took any /uploads/ address would let a team show another team's file, and then delete it by removing it. A list may
 * hold only the uploads the project's gallery holds already (`held`); a new project, none.
 */
export function checkGalleryUploads(sent: readonly string[], held: readonly string[]) {
  if (sent.some((u) => u.startsWith("/uploads/") && !held.includes(u)))
    throw new ValidationError("The project is not valid.", { galleryUrls: ["Use Upload to add an image: an uploaded image's address cannot be typed in."] });
}

/** The uploads a gallery held and no longer does, that no other project shows: their files go after the commit. */
export function droppedGalleryUploads(tx: DbOrTx, before: readonly string[], after: readonly string[], projectId: string): string[] {
  return before.filter((u) => u.startsWith("/uploads/") && !after.includes(u) && !shownElsewhere(tx, u, projectId));
}

/**
 * The project form's body. Which built-in fields must be filled is the organizer's choice
 * (src/lib/project-fields.ts): a required title or track is needed even for a draft, as always;
 * the other required fields are checked on submit (assertSubmittable). Optional and hidden ones
 * may be left out; a hidden one is ignored when sent, and what is stored in it stays.
 * `gallery: false` (an edit of a saved project) ignores galleryUrls whatever it holds: see updateProject.
 */
function projectInput(modes: FieldModes, { gallery = true }: { gallery?: boolean } = {}) {
  const needed = (f: "title" | "trackId", s: z.ZodString) => (modes[f] === "required" ? s.min(1, REQUIRED_MESSAGES[f]) : s.default(""));
  return z.object({
    title: needed("title", z.string().trim().max(120)),
    summary: z.string().trim().max(280).default(""),
    description: z.string().trim().max(20_000).default(""),
    trackId: needed("trackId", z.string().trim()),
    repoUrl: optionalUrl,
    videoUrl: optionalUrl,
    liveUrl: optionalUrl,
    /** the gallery card's image: one uploaded here (its /uploads/ address, sent back as it is) or on the team's own host, http(s) only */
    thumbnailUrl: z
      .string()
      .trim()
      .max(500)
      .refine((v) => v === "" || UPLOAD_PATH.test(v) || webUrl.safeParse(v).success, WEB_URL.message)
      .optional()
      .transform((v) => (v ? v : null)),
    galleryUrls: gallery ? galleryList.default([]) : z.unknown().optional().transform((): string[] => []),
    tags: tagList,
    answers: z.record(z.string(), z.string().trim().max(5_000)).default({}),
    status: z.enum(["draft", "submitted"]).default("submitted"),
  });
}
/** The body as an event with the default fields takes it (the API reference shows this one). */
export const ProjectInput = projectInput(DEFAULT_FIELD_MODES);
export type ProjectInput = z.input<typeof ProjectInput>;

// An uploaded picture is set only by uploading it. Its address is public on the gallery card, so a
// project form that took any /uploads/ address would let a team point its project at another team's
// file, and then delete that file by replacing or taking down its own picture.
const typedUpload = () =>
  new ValidationError("The project is not valid.", { thumbnailUrl: ["Use Upload for a picture: an uploaded picture's address cannot be typed in."] });

export function teamOf(tx: DbOrTx, userId: string, eventId: string) {
  return tx
    .select({ id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.eventId, eventId)))
    .get();
}

type Input = z.output<typeof ProjectInput>;

function parse(body: unknown, modes: FieldModes, options?: { gallery?: boolean }): Input {
  const parsed = projectInput(modes, options).safeParse(body);
  if (!parsed.success) throw new ValidationError("The project is not valid.", issuesOf(parsed.error));
  return parsed.data;
}

/** The built-in fields a save stores. */
type Values = Pick<
  typeof projects.$inferSelect,
  "title" | "summary" | "description" | "trackId" | "repoUrl" | "videoUrl" | "liveUrl" | "thumbnailUrl" | "galleryUrls" | "tags"
>;

/** A project needs a title everywhere it is shown; one the team does not give is its team's name. */
const titleFrom = (teamName: string) => teamName.trim() || "Untitled project";

/**
 * What a save stores in each built-in field: what was sent, except that a hidden field keeps what
 * is stored (nothing, for a new project), a hidden track is the event's one track, and a title left
 * empty where it is optional, or never asked, is the team's name. A saved project's gallery is
 * always what is stored: it changes only through its own route (setGallery), never with a Save.
 */
function resolve(tx: Tx, eventId: string, input: Input, modes: FieldModes, stored: Values | null, teamName: string): Values {
  const pick = <K extends Exclude<keyof Values, "title" | "trackId">>(f: K, empty: Values[K]): Values[K] =>
    modes[f] === "hidden" ? (stored ? stored[f] : empty) : input[f];
  const onlyTrack = () => tx.select({ id: tracks.id }).from(tracks).where(eq(tracks.eventId, eventId)).orderBy(asc(tracks.position)).get()?.id ?? "";
  return {
    title: modes.title === "hidden" ? (stored?.title ?? titleFrom(teamName)) : input.title || titleFrom(teamName),
    summary: pick("summary", ""),
    description: pick("description", ""),
    trackId: modes.trackId === "hidden" ? (stored?.trackId ?? onlyTrack()) : input.trackId,
    repoUrl: pick("repoUrl", null),
    videoUrl: pick("videoUrl", null),
    liveUrl: pick("liveUrl", null),
    thumbnailUrl: pick("thumbnailUrl", null),
    galleryUrls: stored ? stored.galleryUrls : pick("galleryUrls", []),
    tags: pick("tags", []),
  };
}

const isEmpty = (v: unknown) => (Array.isArray(v) ? v.length === 0 : !v);

/**
 * Checks that only matter for a submission (a draft may be incomplete): every built-in field the
 * organizer made required, and every required question. A required title or track is checked on
 * every save, by the parse.
 */
function assertSubmittable(tx: Tx, eventId: string, values: Values, answers: Record<string, string>, modes: FieldModes) {
  const missing: Record<string, string[]> = {};
  for (const f of PROJECT_FIELDS) {
    if (f === "title" || f === "trackId") continue;
    if (modes[f] === "required" && isEmpty(values[f])) missing[f] = [REQUIRED_MESSAGES[f]];
  }
  const required = tx
    .select({ id: customQuestions.id, label: customQuestions.label })
    .from(customQuestions)
    .where(and(eq(customQuestions.eventId, eventId), eq(customQuestions.required, true)))
    .all();
  for (const q of required) if (!answers[q.id]) missing[`answers.${q.id}`] = [`"${q.label}" is required to submit`];
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

/** The answers stored for a project, by question id. */
function storedAnswers(tx: Tx, projectId: string): Record<string, string> {
  const rows = tx.select({ id: customAnswers.questionId, value: customAnswers.value }).from(customAnswers).where(eq(customAnswers.projectId, projectId)).all();
  return Object.fromEntries(rows.map((r) => [r.id, r.value]));
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
 * The id a team's project gets, worked out from the team. The "my project" page draws the
 * team's picture from it before the first save, so the picture the team sees while filling
 * in the form is the one the project keeps everywhere.
 */
export function projectIdFor(teamId: string): string {
  return derivedId("prj", `project-of:${teamId}`);
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
      const modes = fieldModes(tx, event.id);
      const input = parse(body, modes);
      const t = team!;
      const values = resolve(tx, event.id, input, modes, null, t.name);
      if (values.thumbnailUrl?.startsWith("/uploads/")) throw typedUpload();
      checkGalleryUploads(values.galleryUrls, []);
      const existing = tx.select({ id: projects.id }).from(projects).where(eq(projects.teamId, t.id)).get();
      if (existing) {
        throw new ConflictError("team_has_project", `Team ${t.name} already has project ${existing.id}; edit it instead.`);
      }
      requireTrack(tx, values.trackId, event.id);
      if (input.status === "submitted") assertSubmittable(tx, event.id, values, input.answers, modes);
      const now = new Date().toISOString();
      // the id the team's picture was drawn from before this save; a random one only if some row holds it already
      const planned = projectIdFor(t.id);
      const taken = tx.select({ id: projects.id }).from(projects).where(eq(projects.id, planned)).get();
      const row = {
        id: taken ? newId("prj") : planned,
        eventId: event.id,
        teamId: t.id,
        ...values,
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

// no galleryUrls: an edit never changes the gallery (updateProject)
const EDITABLE = ["title", "summary", "description", "trackId", "repoUrl", "videoUrl", "liveUrl", "thumbnailUrl", "tags", "status"] as const;

const sameField = (a: unknown, b: unknown) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);

/**
 * Edit (and optionally submit) a project. Only its team's members, and only while
 * submissions are open. A submitted project stays submitted: "draft" in the body
 * keeps the old status. The audit row records exactly the fields that changed.
 *
 * The gallery is not edited here: galleryUrls in the body is ignored and the stored list stays. It changes only
 * through its own route (setGallery, addGalleryImage), which checks the list the page last saw, and an organizer's
 * take-down. A Save from a page loaded before a teammate's upload, removal or reorder, or an organizer's take-down,
 * therefore neither deletes the new upload, nor is refused for naming one that is gone, nor brings one back.
 */
export function updateProject(actor: Actor | null, projectId: string, body: unknown) {
  let project: typeof projects.$inferSelect;
  let teamName = "";
  // an uploaded picture the save changes or clears is deleted after the commit, unless another project shows it
  const dropped: string[] = [];
  const result = mutate({
    actor,
    action: "project.edit",
    load: (tx) => {
      const p = tx.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!p) throw new NotFoundError("Project");
      project = p;
      teamName = tx.select({ name: teams.name }).from(teams).where(eq(teams.id, p.teamId)).get()?.name ?? "";
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
      const modes = fieldModes(tx, project.eventId);
      const input = parse(body, modes, { gallery: false });
      const values = resolve(tx, project.eventId, input, modes, project, teamName);
      if (values.thumbnailUrl?.startsWith("/uploads/") && values.thumbnailUrl !== project.thumbnailUrl) throw typedUpload();
      requireTrack(tx, values.trackId, project.eventId);
      if (values.trackId !== project.trackId) {
        // Judges assigned in the old track would lose it (a track judge never sees another track).
        const assigned = tx
          .select({ id: assignments.id })
          .from(assignments)
          .where(and(eq(assignments.projectId, project.id), ne(assignments.status, "recused")))
          .get();
        if (assigned) {
          throw new ConflictError("track_locked", "Judges are already assigned to this project in its track, so the track is fixed now. Ask the organizer if it is wrong.");
        }
      }
      const status = project.status === "submitted" ? "submitted" : input.status;
      // an answer the body leaves out stays stored (writeAnswers), so the check sees the stored answers overlaid by the body's
      if (status === "submitted") assertSubmittable(tx, project.eventId, values, { ...storedAnswers(tx, project.id), ...input.answers }, modes);
      const now = new Date().toISOString();
      const next = { ...values, status };
      if (project.thumbnailUrl && project.thumbnailUrl !== next.thumbnailUrl && !shownElsewhere(tx, project.thumbnailUrl, project.id)) dropped.push(project.thumbnailUrl);
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const k of EDITABLE) {
        if (!sameField(project[k], next[k])) {
          before[k] = project[k];
          after[k] = next[k];
        }
      }
      const submittedAt = project.submittedAt ?? (status === "submitted" ? now : null);
      tx.update(projects)
        // galleryUrls undefined: the column is not written at all (Drizzle leaves undefined out of an update)
        .set({ ...next, galleryUrls: undefined, submittedAt, updatedAt: now })
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
  for (const u of dropped) discardUpload(u);
  return result;
}

export type Question = { id: string; label: string; help: string; type: "text" | "longtext" | "url"; required: boolean };

export type MyWork = {
  event: ParticipantEventView;
  open: boolean;
  tracks: { id: string; name: string }[];
  questions: Question[];
  /** what the organizer asks for each built-in field: required, optional or hidden */
  fields: FieldModes;
  team: MyTeam | null;
  project: (typeof projects.$inferSelect & { answers: Record<string, string> }) | null;
  /** what the team's picture is drawn from: its project's id, or before the first save the id the project will get */
  faceId: string | null;
  /** after results are published: the team's place, score and every review, judges unnamed */
  feedback: TeamFeedback | null;
  /**
   * The one-person view (no team to name, no invite link, no roles): an event of one person per
   * team, and the person's entry, if they have one, has only them. A team formed before the
   * organizer lowered the size to 1 keeps the team view.
   */
  solo: boolean;
};

export type TeamFeedback = {
  /** how the published run was made: the score engine's method or PAIRWISE_METHOD */
  method: string;
  place: number | null;
  /** the place as every public page shows it: its competition place in the track and whether it is shared (joint 1st, never 1.5) */
  standing: { place: number; joint: boolean } | null;
  /** only when the event's tie-break decided this place: the criterion that split the project's exact score tie */
  tieBrokenBy?: string;
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
  const standing = track && row ? competitionPlaces(track.rows)[track.rows.indexOf(row)]! : null;
  const criteria = rubricOf(db, event.id);
  const merged = new Set([projectId, ...db.select({ id: projects.id }).from(projects).where(eq(projects.duplicateOf, projectId)).all().map((x) => x.id)]);
  const excluded = new Set(judgeSet(db, event.id).excluded);
  // A judge the organizers removed from the event (a wrong account, say) is no reviewer of it: the
  // team never sees their words. Their reviews stay on the organizers' record, out of the ranking.
  const former = formerJudges(db, event.id);
  const reviews = finishedReviews(db, event.id, criteria).filter((r) => merged.has(r.projectId) && !former.has(r.judgeId));
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
    method: published.method,
    place: row?.place ?? null,
    standing: standing && standing.place !== null ? { place: standing.place, joint: standing.joint } : null,
    ...(row && standing && tieDecided(row, standing) && published.tieBreak ? { tieBrokenBy: published.tieBreak.criterion } : {}),
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
  const fields = fieldModes(db, event.id);
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
    event: participantEventView(event),
    open: submissionsOpen(eventFacts(event), new Date()),
    tracks: db
      .select({ id: tracks.id, name: tracks.name })
      .from(tracks)
      .where(eq(tracks.eventId, event.id))
      .orderBy(asc(tracks.position))
      .all(),
    questions: eventQuestions(db, event.id),
    fields,
    team,
    // the team sees its project under the name everyone else sees; the form does not ask for a hidden title, and a save keeps the stored one
    project: project ? { ...project, title: fields.title === "hidden" ? titleFrom(team?.name ?? "") : project.title, answers } : null,
    faceId: project?.id ?? (team ? projectIdFor(team.id) : null),
    feedback: project && project.status === "submitted" ? teamFeedback(db, event, project.id) : null,
    solo: isSolo(event) && (team?.members.length ?? 0) <= 1,
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
  thumbnailUrl: string | null;
  galleryUrls: string[];
  tags: string[];
  submittedAt: string | null;
  /** changedByOrganizersAt: the organizers changed the team (its name or members) after submissions closed, last at this time */
  team: { name: string; members: number; changedByOrganizersAt: string | null };
  track: { id: string; name: string };
  answers: { label: string; value: string }[];
  duplicateOf: string | null;
};

/** One submitted project as the public sees it. Drafts are not public; scores never appear here. */
export function getPublicProject(eventIdOrSlug: string, projectId: string): { event: EventRow; project: PublicProject; fields: FieldModes } {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const p = db
    .select({
      id: projects.id,
      title: shownTitle(),
      summary: projects.summary,
      description: projects.description,
      repoUrl: projects.repoUrl,
      videoUrl: projects.videoUrl,
      liveUrl: projects.liveUrl,
      thumbnailUrl: projects.thumbnailUrl,
      galleryUrls: projects.galleryUrls,
      tags: projects.tags,
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
  const fields = fieldModes(db, event.id);
  return {
    event,
    fields,
    project: withoutHidden({
      id: p.id,
      title: p.title,
      summary: p.summary,
      description: p.description,
      repoUrl: p.repoUrl,
      videoUrl: p.videoUrl,
      liveUrl: p.liveUrl,
      thumbnailUrl: p.thumbnailUrl,
      galleryUrls: p.galleryUrls,
      tags: p.tags,
      submittedAt: p.submittedAt,
      team: { name: p.teamName, members, changedByOrganizersAt: organizerChangedAfterClose(db, event, p.teamId) },
      track: { id: p.trackId, name: p.trackName },
      answers,
      duplicateOf: p.duplicateOf,
    }, fields),
  };
}
