import "server-only";

// The public face of the data access layer. Pages, route handlers and server
// actions import from here and nowhere else under src/server (the boundary test
// enforces it), so every read and write passes the same authorize() gate.

export { currentActor } from "../session";
export type { Actor } from "../authz";
export { HttpError, AuthzError, NotFoundError, ValidationError, ConflictError } from "../errors";
export { getAbout, getGallery, listEvents, type About, type Gallery, type GalleryProject, type PublicEvent } from "./events";
export {
  createProject,
  updateProject,
  getMyWork,
  getPublicProject,
  ProjectInput,
  type MyWork,
  type PublicProject,
  type Question,
} from "./projects";
export { createTeam, joinTeam, rotateInvite, inviteByCode, type InviteView, type MyTeam } from "./teams";
export { signUp } from "./accounts";
export {
  createEvent,
  getOrganizerEvent,
  organizedEvents,
  savePrizes,
  saveQuestions,
  saveRubric,
  saveTracks,
  updateEventDetails,
  type OrganizerEvent,
} from "./organize";
export { getJudgeScores, type JudgeReview, type JudgeScores } from "./scores";
export { exportFile, EXPORT_FILES } from "./exports";
export { actionError, json, route, type ActionResult } from "../http";
export { actorNav, type NavLink } from "./nav";
export {
  demoIdentities,
  healthCheck,
  homeFor,
  signInAsDemo,
  signInWithPassword,
  signOut,
  type DemoIdentity,
  type SignInResult,
} from "./auth";
