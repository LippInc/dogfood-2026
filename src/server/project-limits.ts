import "server-only";

// Sizes of a project's lists, shared by the data access layer and the event import, so
// whatever the portal accepts (and so exports) always imports back.

export const MAX_GALLERY_IMAGES = 6;
export const MAX_TAGS = 8;
/** long enough for "human-computer-interaction" (26) and its kind */
export const MAX_TAG_LENGTH = 40;
/** The event's own questions to teams: the Questions tab (saveQuestions) and every import hold to these. */
export const MAX_QUESTIONS = 20;
export const QUESTION_LABEL = { min: 3, max: 200 } as const;
export const QUESTION_HELP_MAX = 300;
/** A team's size when the event's settings name none: the team pages and an import into an event hold to it. */
export const DEFAULT_MAX_TEAM_SIZE = 4;
