// What a team is asked on the project form: for each built-in field, the organizer's choice of
// required, optional or hidden. Plain data and pure functions, shared by the data layer (which
// enforces and stores the choice) and the pages (which draw the form and the project from it).
//
// The field names are the project form's own (ProjectInput's keys), so a refusal keyed by one
// lands on the right input. An event with no stored choice gets DEFAULT_FIELD_MODES, which is
// exactly how the form behaved before organizers could choose.

export const PROJECT_FIELDS = [
  "title",
  "summary",
  "trackId",
  "description",
  "repoUrl",
  "videoUrl",
  "liveUrl",
  "thumbnailUrl",
  "galleryUrls",
  "tags",
] as const;
export type ProjectField = (typeof PROJECT_FIELDS)[number];

export const FIELD_MODES = ["required", "optional", "hidden"] as const;
export type FieldMode = (typeof FIELD_MODES)[number];

export type FieldModes = Record<ProjectField, FieldMode>;

/** Title and track were always required, and a summary was required to submit; the rest was optional. */
export const DEFAULT_FIELD_MODES: FieldModes = {
  title: "required",
  summary: "required",
  trackId: "required",
  description: "optional",
  repoUrl: "optional",
  videoUrl: "optional",
  liveUrl: "optional",
  thumbnailUrl: "optional",
  galleryUrls: "optional",
  tags: "optional",
};

/**
 * Every project keeps a track (judging, assignment and the per-track rankings depend on it), so a
 * track is never optional, and it can be hidden only while the event has one track: the team then
 * gets that track. With several tracks, each team chooses its own.
 */
export function allowedModes(field: ProjectField, trackCount: number): FieldMode[] {
  if (field !== "trackId") return [...FIELD_MODES];
  return trackCount === 1 ? ["required", "hidden"] : ["required"];
}

/** The label a team and an organizer read, the same on the form, in settings and in refusals. */
export const FIELD_LABELS: Record<ProjectField, string> = {
  title: "Title",
  summary: "One-line summary",
  trackId: "Track",
  description: "What you built",
  repoUrl: "Repository",
  videoUrl: "Demo video",
  liveUrl: "Live demo",
  thumbnailUrl: "Picture",
  galleryUrls: "Image gallery",
  tags: "Tech tags",
};

/** What a required field refuses a submission with, when it is empty. */
export const REQUIRED_MESSAGES: Record<ProjectField, string> = {
  title: "a title is required",
  summary: "a one-line summary is required to submit",
  trackId: "choose a track",
  description: "a write-up of what you built is required to submit",
  repoUrl: "a repository link is required to submit",
  videoUrl: "a demo video link is required to submit",
  liveUrl: "a live demo link is required to submit",
  thumbnailUrl: "a picture is required to submit",
  galleryUrls: "at least one gallery image is required to submit",
  tags: "at least one tech tag is required to submit",
};

/** A stored choice list (possibly partial, possibly from an older export) read over the defaults. */
export function withDefaults(stored: Partial<Record<string, string>>): FieldModes {
  const out = { ...DEFAULT_FIELD_MODES };
  for (const f of PROJECT_FIELDS) {
    const m = stored[f];
    if (m === "required" || m === "optional" || m === "hidden") out[f] = m;
  }
  return out;
}

/** The choices that differ from the defaults: what an export carries, and what "as usual" means. */
export function changedFromDefaults(modes: FieldModes): Partial<FieldModes> {
  return Object.fromEntries(PROJECT_FIELDS.filter((f) => modes[f] !== DEFAULT_FIELD_MODES[f]).map((f) => [f, modes[f]]));
}

export const isHidden = (modes: FieldModes, field: ProjectField) => modes[field] === "hidden";

type Shown = {
  summary?: string;
  description?: string;
  repoUrl?: string | null;
  videoUrl?: string | null;
  liveUrl?: string | null;
  thumbnailUrl?: string | null;
  galleryUrls?: string[];
  tags?: string[];
};

/**
 * A project as it may be shown to someone other than its team: a field the organizer hid is empty.
 * What the team typed before the field was hidden stays stored and shows again if the organizer
 * turns the field back on. The title and the track are never emptied: every project keeps both.
 */
export function withoutHidden<T extends Shown>(project: T, modes: FieldModes): T {
  const out: Shown = { ...project };
  if (modes.summary === "hidden" && "summary" in out) out.summary = "";
  if (modes.description === "hidden" && "description" in out) out.description = "";
  if (modes.repoUrl === "hidden" && "repoUrl" in out) out.repoUrl = null;
  if (modes.videoUrl === "hidden" && "videoUrl" in out) out.videoUrl = null;
  if (modes.liveUrl === "hidden" && "liveUrl" in out) out.liveUrl = null;
  if (modes.thumbnailUrl === "hidden" && "thumbnailUrl" in out) out.thumbnailUrl = null;
  if (modes.galleryUrls === "hidden" && "galleryUrls" in out) out.galleryUrls = [];
  if (modes.tags === "hidden" && "tags" in out) out.tags = [];
  return out as T;
}
