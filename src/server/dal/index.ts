import "server-only";

// The public face of the data access layer. Pages, route handlers and server
// actions import from here and nowhere else under src/server (the boundary test
// enforces it), so every read and write passes the same authorize() gate.

export { currentActor } from "../session";
export { secureCookies } from "../settings";
export type { Actor } from "../authz";
export { HttpError, AuthzError, NotFoundError, ValidationError, ConflictError } from "../errors";
export { eventRef, getAbout, getGallery, getProjectFields, listEvents, type About, type Gallery, type GalleryProject, type PublicEvent } from "./events";
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
export { removeProjectImage, setProjectImage, takeDownProjectImage } from "./project-image";
export { MAX_IMAGE_BYTES, readUpload } from "../uploads";
export {
  createTeam,
  dissolveTeam,
  getTeamForOrganizer,
  joinTeam,
  leaveTeam,
  makeCaptain,
  organizerAddMember,
  organizerRemoveMember,
  removeMember,
  renameTeam,
  rotateInvite,
  inviteByCode,
  type InviteView,
  type MyTeam,
  type OrganizerTeamView,
} from "./teams";
export { signUp } from "./accounts";
export {
  createEvent,
  getOrganizerEvent,
  organizedEvents,
  savePrizes,
  saveProjectFields,
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
  inviteJudges,
  MAX_BATCH_INVITES,
  judgeInviteByCode,
  revokeJudgeInvite,
  setJudgeRanking,
  setJudgeTracks,
  type BatchInvite,
  type BatchResult,
  type InviteRow,
  type JudgeInviteView,
  type JudgeRow,
  type RemovedJudge,
} from "./judges";
export { assignByHand, getAssignments, runAssignment, type RunRow, type RunSummary } from "./assignments";
export {
  getProjectJudging,
  moveProjectTrack,
  removeAssignment,
  removeJudge,
  undoRecusal,
  type JudgeRemoval,
  type ProjectAssignment,
  type ProjectJudging,
  type TrackMove,
} from "./corrections";
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
  KEPT_MIN_TILT,
  METHOD_LABEL,
  type Influence,
  type JudgeStanding,
  type Normalized,
  type ProjectRow,
  type Receipt,
} from "./normalization";
export {
  acceptUnderReviewed,
  dismissDuplicate,
  mergeDuplicate,
  revokeJudgeOverride,
  setJudgeOverride,
  undoAcceptUnderReviewed,
  undoNotDuplicate,
  unmergeDuplicate,
  type Decision,
} from "./decisions";
export {
  getNormalization,
  CORRECTED_FROM,
  getPublishedResults,
  publishResults,
  type PrivateNote,
  type PublishedResults,
  type RankingEvidence,
} from "./results";
export { getEventCards, getOverview, type EventCard, type Overview, type Stage } from "./overview";
export { addOrganizer, listOrganizers, removeOrganizer, type Organizer } from "./organizers";
export { getAuditEntries, getAuditLog, getPortalEntries, getPortalLog, type AuditEntryView, type AuditLine, type Part } from "./audit-log";
export { getSubmissions, type SubmissionRow } from "./submissions";
export {
  castBallot,
  describeVotingCode,
  enterVoting,
  getBallot,
  voteCookieName,
  votingState,
  type BallotView,
  type Client,
} from "./voting";
export {
  addListedVoters,
  getCommunityResults,
  getVotingAdmin,
  makeVotingLink,
  newVoterLink,
  restoreVoter,
  saveVotingSettings,
  voidVoter,
  type CommunityResults,
  type Tally,
} from "./voting-organizer";
export { deleteComment, hideComment, listComments, postComment, unhideComment, type CommentView } from "./comments";
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
export { claimAccount, countBeyondReach, countWithoutPassword, describeClaim, makeClaimLinks, type ClaimLink, type ClaimSkip } from "./claims";
export { describePasswordReset, guardAccounts, makePasswordReset, resetPassword, type ResetLink } from "./password-resets";
export { listOutbox, listPortalOutbox, OUTBOX_PAGE_MAX, type OutboxPage, type OutboxView } from "./outbox";
export { emailIsOn, mailClaimLinks, mailJudgeInvite, mailJudgeInvites, mailPasswordReset, mailVoterLinks, type MailReport, type Mailed } from "./mailing";
export { EVENT_FILE_TOO_LARGE, guardImport, importEventFile, MAX_EVENT_FILE_BYTES, type EventImport } from "./imports";
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
export type { Yardstick } from "../judging/yardstick";
