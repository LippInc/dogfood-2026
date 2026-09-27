import "server-only";

// The public face of the data access layer. Pages, route handlers and server
// actions import from here and nowhere else under src/server (the boundary test
// enforces it), so every read and write passes the same authorize() gate.

export { currentActor } from "../session";
export type { Actor } from "../authz";
export { HttpError, AuthzError, NotFoundError, ValidationError, ConflictError } from "../errors";
export { eventRef, getAbout, getGallery, listEvents, type About, type Gallery, type GalleryProject, type PublicEvent } from "./events";
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
export { createTeam, joinTeam, leaveTeam, makeCaptain, removeMember, rotateInvite, inviteByCode, type InviteView, type MyTeam } from "./teams";
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
export {
  acceptJudgeInvite,
  getJudges,
  inviteJudge,
  judgeInviteByCode,
  revokeJudgeInvite,
  setJudgeTracks,
  type InviteRow,
  type JudgeInviteView,
  type JudgeRow,
} from "./judges";
export { assignByHand, getAssignments, runAssignment, type RunRow, type RunSummary } from "./assignments";
export {
  getJudgeConsole,
  recuseAssignment,
  saveReview,
  type ConsoleItem,
  type ConsoleProject,
  type JudgeConsole,
  type SavedReview,
} from "./reviews";
export type { Criterion } from "./judging";
export {
  acceptUnderReviewed,
  dismissDuplicate,
  getNormalization,
  getPublishedResults,
  mergeDuplicate,
  METHOD_LABEL,
  publishResults,
  revokeJudgeOverride,
  setJudgeOverride,
  undoAcceptUnderReviewed,
  undoNotDuplicate,
  unmergeDuplicate,
  type Decision,
  type Influence,
  type JudgeStanding,
  type Normalized,
  type PrivateNote,
  type ProjectRow,
  type PublishedResults,
  type Receipt,
} from "./normalization";
export { getOverview, type Overview, type Stage } from "./overview";
export { addOrganizer, listOrganizers, removeOrganizer, type Organizer } from "./organizers";
export { getAuditEntries, getAuditLog, getPortalEntries, getPortalLog, type AuditEntryView, type AuditLine, type Part } from "./audit-log";
export { getSubmissions, type SubmissionRow } from "./submissions";
export {
  addListedVoters,
  castBallot,
  describeVotingCode,
  enterVoting,
  getBallot,
  getCommunityResults,
  getVotingAdmin,
  makeVotingLink,
  restoreVoter,
  saveVotingSettings,
  voidVoter,
  voteCookieName,
  votingState,
  type BallotView,
  type Client,
  type CommunityResults,
  type Tally,
} from "./voting";
export { hideComment, listComments, postComment, type CommentView } from "./comments";
export { RateLimitedError } from "../errors";
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
export {
  getRecord,
  issueAllRecords,
  issueOwnRecord,
  issueOwnRecordRequest,
  keysDocument,
  listRecords,
  myRecords,
  verifyRecord,
  RECORD_FORMAT,
  type RecordView,
} from "./records";
export type { Verification } from "../signing";
export { OPERATIONS, openApiDocument, operationId, type Access, type Operation } from "../openapi";
export {
  createWebhook,
  listDeliveries,
  listWebhooks,
  retryDelivery,
  rotateWebhookSecret,
  setWebhookEnabled,
  testWebhook,
  type WebhookView,
} from "./webhooks";
export { claimAccount, countWithoutPassword, describeClaim, makeClaimLinks, type ClaimLink } from "./claims";
export { importEventFile, type EventImport } from "./imports";
export { createApiToken, listApiTokens, revokeApiToken, type TokenView } from "./tokens";
export {
  getPairwiseRanking,
  getPairwiseState,
  judgingModeOf,
  PAIRWISE_METHOD,
  PAIRWISE_METHOD_LABEL,
  pickPairwise,
  PULL_SHOWN_WITHIN,
  pullShare,
  setJudgingMode,
  undoPairwise,
  type CoinFlipFlag,
  type JudgingMode,
  type PairwiseProject,
  type PairwiseRanking,
  type PairwiseState,
  type PairwiseTrackState,
  type ReceiptLine,
} from "./pairwise";
