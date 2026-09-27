// The one schema. Only src/server/** may import this file (tests/dal-boundary.test.ts).
//
// Conventions
// - Ids are text. Fixture rows keep their fixture ids (evt_01, trk_03, prj_32);
//   rows created in the app get a prefixed random id (see src/server/ids.ts).
// - Timestamps are ISO 8601 text in UTC, compared with Date in code, never as strings.
// - Enum-like and range columns carry real CHECK constraints (Drizzle's text enum
//   is TypeScript-only on SQLite). Triggers live in src/server/db/triggers.ts and are
//   re-asserted at every boot.
// - JSON columns only for settings, galleries, tags, run params and audit payloads;
//   every relation is a table.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const isoTimestamp = (column: unknown) => sql`julianday(${column}) is not null`;

// ---------------------------------------------------------------------------
// People, roles, sessions
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(), // stored lowercased
    name: text("name").notNull(),
    // null: this person cannot sign in with a password (imported judges and members
    // sign in through an invite link that sets one).
    passwordHash: text("password_hash"),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("users_email_lowercase", sql`${t.email} = lower(${t.email}) and instr(${t.email}, '@') > 1`),
    check("users_created_at_iso", isoTimestamp(t.createdAt)),
  ],
);

export const ROLES = ["organizer", "judge", "participant"] as const;
export type Role = (typeof ROLES)[number];

// Roles are rows, not a column: a judge who is also a team member is one user with
// two rows here (BUILD-PLAN decision 4).
export const userRoles = sqliteTable(
  "user_roles",
  {
    userId: text("user_id").notNull().references(() => users.id),
    eventId: text("event_id").notNull().references(() => events.id),
    role: text("role", { enum: ROLES }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.eventId, t.role] }),
    index("user_roles_event_role_idx").on(t.eventId, t.role),
    check("user_roles_role_check", sql`${t.role} in ('organizer', 'judge', 'participant')`),
  ],
);

export const SESSION_KINDS = ["login", "checker"] as const;

export const sessions = sqliteTable(
  "sessions",
  {
    // SHA-256 (hex) of the cookie token. The token itself is never stored.
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    kind: text("kind", { enum: SESSION_KINDS }).notNull().default("login"),
    // checker sessions only: organizer, judge_a, judge_b, participant
    label: text("label"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    uniqueIndex("sessions_checker_label_uq").on(t.label),
    check("sessions_kind_check", sql`${t.kind} in ('login', 'checker')`),
    check("sessions_label_check", sql`(${t.kind} = 'checker') = (${t.label} is not null)`),
    check("sessions_expires_at_iso", isoTimestamp(t.expiresAt)),
  ],
);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventSettings = {
  /** Public skin: the event's marker colour and whether the public side starts dark. */
  accent?: string;
  /** Let judges see "your ranking so far" (their own scores only). */
  judgeRanking?: boolean;
  /** Reviews each project should get from assignment. */
  reviewsPerProject?: number;
  /** Most people on one team (invite links refuse beyond it). Default 4. */
  maxTeamSize?: number;
  /** The normalization run the published results come from. */
  publishedRunId?: string;
  /** Project pairs the organizer ruled are not duplicates, as "a|b" with the ids sorted. */
  notDuplicates?: string[];
  /** Under-reviewed projects the organizer chose to publish as they are. */
  acceptedUnderReviewed?: string[];
  /** Community voting (T3): who may vote, how many favourites each, the open link's hash. */
  voting?: { modes: ("account" | "listed" | "link")[]; votesPerVoter: number; linkHash?: string | null };
  /** How judges judge (decision 18): a rubric per project (the default) or the better of two. */
  judgingMode?: "scores" | "pairwise";
};

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // null: submissions are open from the moment the event exists
    submissionsOpenAt: text("submissions_open_at"),
    submissionsCloseAt: text("submissions_close_at").notNull(),
    judgingCloseAt: text("judging_close_at"),
    votingOpenAt: text("voting_open_at"),
    votingCloseAt: text("voting_close_at"),
    resultsPublishedAt: text("results_published_at"),
    settings: text("settings", { mode: "json" }).$type<EventSettings>().notNull().default(sql`'{}'`),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("events_slug_format", sql`${t.slug} glob '[a-z0-9]*' and ${t.slug} not glob '*[^a-z0-9-]*'`),
    check("events_close_iso", isoTimestamp(t.submissionsCloseAt)),
    check(
      "events_window_order",
      sql`${t.submissionsOpenAt} is null or julianday(${t.submissionsOpenAt}) < julianday(${t.submissionsCloseAt})`,
    ),
    check(
      "events_voting_order",
      sql`${t.votingOpenAt} is null or ${t.votingCloseAt} is null or julianday(${t.votingOpenAt}) < julianday(${t.votingCloseAt})`,
    ),
    check("events_settings_json", sql`json_valid(${t.settings})`),
  ],
);

export const tracks = sqliteTable(
  "tracks",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    uniqueIndex("tracks_event_name_uq").on(t.eventId, t.name),
    // target of composite foreign keys that keep a row's track inside its own event
    uniqueIndex("tracks_id_event_uq").on(t.id, t.eventId),
  ],
);

export const prizes = sqliteTable("prizes", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => events.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  position: integer("position").notNull().default(0),
});

// ---------------------------------------------------------------------------
// Teams and projects
// ---------------------------------------------------------------------------

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    name: text("name").notNull(),
    // capability for the invite link /join/<code>; rotating it revokes old links
    inviteCode: text("invite_code").notNull().unique(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    // Team names are display names and may repeat: the fixture has three teams
    // called StillTrail. The id identifies a team.
    index("teams_event_idx").on(t.eventId),
    uniqueIndex("teams_id_event_uq").on(t.id, t.eventId),
  ],
);

export const TEAM_ROLES = ["captain", "member"] as const;

export const teamMembers = sqliteTable(
  "team_members",
  {
    eventId: text("event_id").notNull(),
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role", { enum: TEAM_ROLES }).notNull().default("member"),
    joinedAt: text("joined_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    // one team per person per event, enforced by the database, not only the app
    uniqueIndex("team_members_one_team_per_event_uq").on(t.eventId, t.userId),
    foreignKey({ columns: [t.teamId, t.eventId], foreignColumns: [teams.id, teams.eventId] }),
    check("team_members_role_check", sql`${t.role} in ('captain', 'member')`),
  ],
);

export const PROJECT_STATUSES = ["draft", "submitted"] as const;

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    teamId: text("team_id").notNull(),
    trackId: text("track_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    description: text("description").notNull().default(""),
    repoUrl: text("repo_url"),
    videoUrl: text("video_url"),
    liveUrl: text("live_url"),
    thumbnailUrl: text("thumbnail_url"),
    galleryUrls: text("gallery_urls", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    status: text("status", { enum: PROJECT_STATUSES }).notNull().default("draft"),
    submittedAt: text("submitted_at"),
    // set by the organizer's audited duplicate merge; the row itself is never deleted
    duplicateOf: text("duplicate_of"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("projects_event_idx").on(t.eventId),
    index("projects_track_idx").on(t.trackId),
    index("projects_team_idx").on(t.teamId),
    uniqueIndex("projects_id_event_uq").on(t.id, t.eventId),
    foreignKey({ columns: [t.teamId, t.eventId], foreignColumns: [teams.id, teams.eventId] }),
    foreignKey({ columns: [t.trackId, t.eventId], foreignColumns: [tracks.id, tracks.eventId] }),
    foreignKey({ columns: [t.duplicateOf, t.eventId], foreignColumns: [t.id, t.eventId] }),
    check("projects_status_check", sql`${t.status} in ('draft', 'submitted')`),
    check("projects_submitted_has_time", sql`${t.status} = 'draft' or ${t.submittedAt} is not null`),
    check("projects_title_nonempty", sql`length(trim(${t.title})) > 0`),
    check("projects_not_own_duplicate", sql`${t.duplicateOf} is null or ${t.duplicateOf} <> ${t.id}`),
    check("projects_gallery_json", sql`json_valid(${t.galleryUrls}) and json_valid(${t.tags})`),
  ],
);

export const QUESTION_TYPES = ["text", "longtext", "url"] as const;

export const customQuestions = sqliteTable(
  "custom_questions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    label: text("label").notNull(),
    help: text("help").notNull().default(""),
    type: text("type", { enum: QUESTION_TYPES }).notNull().default("longtext"),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (t) => [check("custom_questions_type_check", sql`${t.type} in ('text', 'longtext', 'url')`)],
);

export const customAnswers = sqliteTable(
  "custom_answers",
  {
    projectId: text("project_id").notNull().references(() => projects.id),
    questionId: text("question_id").notNull().references(() => customQuestions.id),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.questionId] })],
);

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

// The scoring form renders from these rows. The organizer sets the weights; a
// score's range is enforced in the data access layer and by a trigger on
// score_items that reads its criterion's range (a CHECK constraint cannot).
export const rubricCriteria = sqliteTable(
  "rubric_criteria",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    key: text("key").notNull(),
    label: text("label").notNull(),
    prompt: text("prompt").notNull().default(""),
    weight: real("weight").notNull().default(1),
    scaleMin: integer("scale_min").notNull().default(1),
    scaleMax: integer("scale_max").notNull().default(5),
    // anchor text per level, e.g. {"5": "Works end to end, as claimed"}
    anchors: text("anchors", { mode: "json" }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    uniqueIndex("rubric_event_key_uq").on(t.eventId, t.key),
    check("rubric_weight_positive", sql`${t.weight} > 0`),
    check("rubric_scale_order", sql`${t.scaleMin} >= 0 and ${t.scaleMin} < ${t.scaleMax} and ${t.scaleMax} <= 100`),
    check("rubric_anchors_json", sql`json_valid(${t.anchors})`),
  ],
);

export const judgeTracks = sqliteTable(
  "judge_tracks",
  {
    judgeUserId: text("judge_user_id").notNull().references(() => users.id),
    eventId: text("event_id").notNull(),
    trackId: text("track_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.judgeUserId, t.eventId, t.trackId] }),
    foreignKey({ columns: [t.trackId, t.eventId], foreignColumns: [tracks.id, tracks.eventId] }),
  ],
);

// An organizer invites a judge with a link. Only the SHA-256 of the link's code is
// stored, so the link is shown once. Whoever opens it signed in (with the invited
// email, when one is given) becomes a judge for the listed tracks.
export const judgeInvites = sqliteTable(
  "judge_invites",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    codeHash: text("code_hash").notNull().unique(),
    name: text("name").notNull().default(""),
    email: text("email"),
    trackIds: text("track_ids", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
    acceptedAt: text("accepted_at"),
    acceptedBy: text("accepted_by").references(() => users.id),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    index("judge_invites_event_idx").on(t.eventId),
    check("judge_invites_tracks_json", sql`json_valid(${t.trackIds}) and json_type(${t.trackIds}) = 'array'`),
    check("judge_invites_email_lower", sql`${t.email} is null or ${t.email} = lower(${t.email})`),
    check("judge_invites_one_outcome", sql`${t.acceptedAt} is null or ${t.revokedAt} is null`),
  ],
);

export const ASSIGNMENT_RUN_MODES = ["fixture", "fresh", "topup"] as const;

export const assignmentRuns = sqliteTable(
  "assignment_runs",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    mode: text("mode", { enum: ASSIGNMENT_RUN_MODES }).notNull(),
    seed: integer("seed").notNull(),
    params: text("params", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by"),
  },
  (t) => [
    check("assignment_runs_mode_check", sql`${t.mode} in ('fixture', 'fresh', 'topup')`),
    check("assignment_runs_params_json", sql`json_valid(${t.params})`),
  ],
);

export const ASSIGNMENT_STATUSES = ["pending", "done", "recused"] as const;

export const assignments = sqliteTable(
  "assignments",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    judgeUserId: text("judge_user_id").notNull().references(() => users.id),
    projectId: text("project_id").notNull(),
    runId: text("run_id").notNull().references(() => assignmentRuns.id),
    batchNo: integer("batch_no").notNull().default(1),
    // the judge's own seeded review order inside the batch
    position: integer("position").notNull().default(0),
    status: text("status", { enum: ASSIGNMENT_STATUSES }).notNull().default("pending"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("assignments_judge_project_uq").on(t.judgeUserId, t.projectId),
    index("assignments_project_idx").on(t.projectId),
    index("assignments_event_judge_idx").on(t.eventId, t.judgeUserId),
    foreignKey({ columns: [t.projectId, t.eventId], foreignColumns: [projects.id, projects.eventId] }),
    check("assignments_status_check", sql`${t.status} in ('pending', 'done', 'recused')`),
    check("assignments_batch_positive", sql`${t.batchNo} >= 1`),
  ],
);

// Judge and project come from the assignment; they are not stored twice.
export const scores = sqliteTable(
  "scores",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id").notNull().unique().references(() => assignments.id),
    // set when every criterion is scored; a partial review stays a draft
    submittedAt: text("submitted_at"),
    updatedAt: text("updated_at").notNull(),
    // an imported score whose judge is a member of the scored project's team
    conflicted: integer("conflicted", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [check("scores_updated_at_iso", isoTimestamp(t.updatedAt))],
);

export const scoreItems = sqliteTable(
  "score_items",
  {
    scoreId: text("score_id").notNull().references(() => scores.id),
    criterionId: text("criterion_id").notNull().references(() => rubricCriteria.id),
    value: integer("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.scoreId, t.criterionId] })],
);

export const scoreComments = sqliteTable("score_comments", {
  scoreId: text("score_id").primaryKey().references(() => scores.id),
  // shown to the team after results are published
  feedback: text("feedback").notNull().default(""),
  // shown to organizers only
  privateNote: text("private_note").notNull().default(""),
});

export const JUDGE_OVERRIDE_MODES = ["include", "exclude"] as const;

// Decision 11: the organizer can reinstate a flagged judge or exclude an unflagged
// one, with a required reason, and undo either. Every change is audited.
export const judgeOverrides = sqliteTable(
  "judge_overrides",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    judgeUserId: text("judge_user_id").notNull().references(() => users.id),
    mode: text("mode", { enum: JUDGE_OVERRIDE_MODES }).notNull(),
    reason: text("reason").notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by"),
  },
  (t) => [
    check("judge_overrides_mode_check", sql`${t.mode} in ('include', 'exclude')`),
    check("judge_overrides_reason_nonempty", sql`length(trim(${t.reason})) >= 3`),
  ],
);

// Pairwise mode (decision 18): one row per answer a judge gave to "which is better?".
// Never updated except voided_at (the judge's undo) and never deleted; the judge's list
// and next question are replayed from these rows. new_project_id is the one being placed.
export const PAIRWISE_OUTCOMES = ["left", "right", "tie"] as const;
export const comparisons = sqliteTable(
  "comparisons",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    judgeUserId: text("judge_user_id").notNull().references(() => users.id),
    trackId: text("track_id").notNull(),
    leftProjectId: text("left_project_id").notNull(),
    rightProjectId: text("right_project_id").notNull(),
    newProjectId: text("new_project_id").notNull(),
    outcome: text("outcome", { enum: PAIRWISE_OUTCOMES }).notNull(),
    createdAt: text("created_at").notNull(),
    voidedAt: text("voided_at"),
  },
  (t) => [
    index("comparisons_event_judge_idx").on(t.eventId, t.judgeUserId),
    uniqueIndex("comparisons_once").on(t.eventId, t.judgeUserId, t.leftProjectId, t.rightProjectId).where(sql`voided_at is null`),
    foreignKey({ columns: [t.leftProjectId, t.eventId], foreignColumns: [projects.id, projects.eventId] }),
    foreignKey({ columns: [t.rightProjectId, t.eventId], foreignColumns: [projects.id, projects.eventId] }),
    foreignKey({ columns: [t.trackId, t.eventId], foreignColumns: [tracks.id, tracks.eventId] }),
    check("comparisons_outcome_check", sql`${t.outcome} in ('left', 'right', 'tie')`),
    check("comparisons_two_projects", sql`${t.leftProjectId} <> ${t.rightProjectId}`),
    check("comparisons_new_is_shown", sql`${t.newProjectId} in (${t.leftProjectId}, ${t.rightProjectId})`),
    check("comparisons_created_iso", isoTimestamp(t.createdAt)),
    check("comparisons_voided_iso", sql`${t.voidedAt} is null or julianday(${t.voidedAt}) is not null`),
  ],
);

export const normalizationRuns = sqliteTable(
  "normalization_runs",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    method: text("method").notNull(),
    // k, beta2, sigma2, the judge set, flat judges, overrides, merges
    params: text("params", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    computedAt: text("computed_at").notNull(),
    computedBy: text("computed_by"),
  },
  (t) => [check("normalization_runs_params_json", sql`json_valid(${t.params})`)],
);

export const normalizedScores = sqliteTable(
  "normalized_scores",
  {
    runId: text("run_id").notNull().references(() => normalizationRuns.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    n: integer("n").notNull(),
    rawMean: real("raw_mean"),
    normalizedMean: real("normalized_mean"),
    // one standard error of the normalized mean (JUDGING.md); null in runs stored before it existed
    se: real("se"),
    rankRaw: real("rank_raw"),
    rankNormalized: real("rank_normalized"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.projectId] })],
);

// ---------------------------------------------------------------------------
// Community voting and comments (T3)
// ---------------------------------------------------------------------------

// Who may vote is the organizer's choice, per event: signed-in accounts, people on
// a voter list (each gets a personal link), or anyone holding the event's open
// voting link. One voter row per person per event; the personal or browser token
// is stored only as its SHA-256. The address and browser hashes (salted) exist
// only to flag suspected duplicate voters for the organizer, never to identify.
export const VOTER_KINDS = ["account", "listed", "link"] as const;

export const voters = sqliteTable(
  "voters",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    kind: text("kind", { enum: VOTER_KINDS }).notNull(),
    userId: text("user_id").references(() => users.id),
    email: text("email"),
    tokenHash: text("token_hash").unique(),
    // seeds this voter's own shuffled ballot order
    orderSeed: integer("order_seed").notNull(),
    ipHash: text("ip_hash"),
    agentHash: text("agent_hash"),
    createdAt: text("created_at").notNull(),
    lastVotedAt: text("last_voted_at"),
    voidedAt: text("voided_at"),
    voidedBy: text("voided_by"),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("voters_event_user_uq").on(t.eventId, t.userId),
    uniqueIndex("voters_event_email_uq").on(t.eventId, t.email),
    index("voters_event_ip_idx").on(t.eventId, t.ipHash),
    check("voters_kind_check", sql`${t.kind} in ('account', 'listed', 'link')`),
    check(
      "voters_kind_identity",
      sql`(${t.kind} = 'account' and ${t.userId} is not null) or (${t.kind} = 'listed' and ${t.email} is not null and ${t.tokenHash} is not null) or (${t.kind} = 'link' and ${t.tokenHash} is not null)`,
    ),
    check("voters_email_lower", sql`${t.email} is null or ${t.email} = lower(${t.email})`),
    check("voters_void_reason", sql`${t.voidedAt} is null or length(trim(coalesce(${t.voidReason}, ''))) >= 3`),
  ],
);

export const votes = sqliteTable(
  "votes",
  {
    voterId: text("voter_id").notNull().references(() => voters.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.voterId, t.projectId] }), index("votes_project_idx").on(t.projectId)],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    projectId: text("project_id").notNull().references(() => projects.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
    hiddenAt: text("hidden_at"),
    hiddenBy: text("hidden_by"),
    hiddenReason: text("hidden_reason"),
  },
  (t) => [
    index("comments_project_idx").on(t.projectId, t.createdAt),
    check("comments_body_length", sql`length(trim(${t.body})) between 1 and 2000`),
    check("comments_hidden_reason", sql`${t.hiddenAt} is null or length(trim(coalesce(${t.hiddenReason}, ''))) >= 3`),
  ],
);

// ---------------------------------------------------------------------------
// Signed records
// ---------------------------------------------------------------------------

export type PublicJwk = { kty: "OKP"; crv: "Ed25519"; x: string };

/** A record exactly as signed, and its Ed25519 signature (base64url) over the record's canonical JSON. */
export type SignedEnvelope = { record: Record<string, unknown>; signature: string };

// The portal's Ed25519 signing key, made at first boot. The private half never
// leaves this table; the public half is served at /.well-known/dogfood-keys.json.
export const signingKeys = sqliteTable(
  "signing_keys",
  {
    id: text("id").primaryKey(),
    publicJwk: text("public_jwk", { mode: "json" }).$type<PublicJwk>().notNull(),
    privatePkcs8: text("private_pkcs8").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [check("signing_keys_created_iso", isoTimestamp(t.createdAt))],
);

export const RECORD_KINDS = ["judge", "participant"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

// One signed record per person, event and kind: a judge's participation record, or
// a team member's certificate. The envelope is what was signed, plus the signature.
export const signedRecords = sqliteTable(
  "signed_records",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    kind: text("kind", { enum: RECORD_KINDS }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    keyId: text("key_id")
      .notNull()
      .references(() => signingKeys.id),
    envelope: text("envelope", { mode: "json" }).$type<SignedEnvelope>().notNull(),
    issuedAt: text("issued_at").notNull(),
  },
  (t) => [
    uniqueIndex("signed_records_once").on(t.eventId, t.kind, t.userId),
    check("signed_records_kind", sql`${t.kind} in ('judge', 'participant')`),
    check("signed_records_issued_iso", isoTimestamp(t.issuedAt)),
  ],
);

// ---------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------

// A person's named tokens for scripts: sent as Authorization: Bearer <token>, they
// act as that person with that person's permissions. Shown once; only the SHA-256
// is stored. A token cannot be used to make or revoke tokens.
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** the first characters of the token, so a person can tell their tokens apart */
    hint: text("hint").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    index("api_tokens_user_idx").on(t.userId),
    check("api_tokens_name", sql`length(trim(${t.name})) between 1 and 60`),
    check("api_tokens_expiry", sql`${t.expiresAt} is null or julianday(${t.expiresAt}) > julianday(${t.createdAt})`),
  ],
);

// ---------------------------------------------------------------------------
// Account claims
// ---------------------------------------------------------------------------

// People who came in through an import have no password. An organizer makes each
// a personal link (the token is shown once; only its SHA-256 is stored); opening it
// lets that person set a password. One unused claim per person: a new link replaces it.
export const accountClaims = sqliteTable(
  "account_claims",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (t) => [
    index("account_claims_user_idx").on(t.userId),
    check("account_claims_expiry", sql`julianday(${t.expiresAt}) > julianday(${t.createdAt})`),
  ],
);

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

// An organizer's subscription: audited actions in one event, POSTed to a URL and
// signed with the webhook's own secret (HMAC-SHA256). actions is ["*"] for all.
export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => events.id),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    actions: text("actions", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    disabledAt: text("disabled_at"),
  },
  (t) => [
    index("webhooks_event_idx").on(t.eventId),
    check("webhooks_url_scheme", sql`${t.url} like 'http://%' or ${t.url} like 'https://%'`),
    check("webhooks_created_iso", isoTimestamp(t.createdAt)),
  ],
);

export const DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// The outbox and delivery log: a row is written in the same transaction as the
// audited change, and the worker (../webhooks.ts) sends it, with retries.
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id),
    auditId: integer("audit_id"),
    action: text("action").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: DELIVERY_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    lastAttemptAt: text("last_attempt_at"),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    deliveredAt: text("delivered_at"),
  },
  (t) => [
    index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
    index("webhook_deliveries_hook_idx").on(t.webhookId, t.createdAt),
    check("webhook_deliveries_status", sql`${t.status} in ('pending', 'delivered', 'failed')`),
    check("webhook_deliveries_attempts", sql`${t.attempts} between 0 and 20`),
  ],
);

// ---------------------------------------------------------------------------
// Audit and imports
// ---------------------------------------------------------------------------

// Append-only by construction: triggers reject UPDATE and DELETE (triggers.ts),
// and each row carries the hash of the row before it.
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    actorUserId: text("actor_user_id"), // null: the system (boot, import)
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    eventId: text("event_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    before: text("before", { mode: "json" }),
    after: text("after", { mode: "json" }),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull().unique(),
  },
  (t) => [
    index("audit_event_idx").on(t.eventId, t.id),
    check("audit_at_iso", isoTimestamp(t.at)),
    check("audit_hash_format", sql`length(${t.hash}) = 64 and length(${t.prevHash}) = 64`),
  ],
);

export const fixtureImports = sqliteTable("fixture_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(),
  sha256: text("sha256").notNull(),
  importedAt: text("imported_at").notNull(),
  counts: text("counts", { mode: "json" }).$type<Record<string, number>>().notNull(),
});
