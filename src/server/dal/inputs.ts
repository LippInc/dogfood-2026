import "server-only";

// Every request body the DAL validates, by name: the one source for the API
// reference (src/server/openapi.ts), so the documented shapes are the checked ones.

export { SignUp } from "./accounts";
export { ManualInput, RunInput } from "./assignments";
export { CommentInput, HideInput } from "./comments";
export { InviteInput, TrackIds } from "./judges";
export { AcceptInput, MergeInput, OverrideInput, PairInput, RevokeInput, UndoPairInput, UnmergeInput } from "./decisions";
export { Details, NewEvent, PrizeRows, QuestionRows, RubricBody, RubricRows, TrackRows } from "./organize";
export { ProjectInput } from "./projects";
export { ProjectFieldsInput } from "./project-fields";
export { RecordRequest } from "./records";
export { RecuseInput, ReviewInput } from "./reviews";
export { CaptainInput, RenameInput, TeamName } from "./teams";
export { BallotInput } from "./voting";
export { RestoreInput, SettingsInput, VoidInput, VoterAddress, VoterList } from "./voting-organizer";
export { WebhookInput } from "./webhooks";
export { ClaimInput } from "./claims";
export { ResetInput, ResetLinkInput } from "./password-resets";
export { TokenInput } from "./tokens";
export { OrganizerInput } from "./organizers";
export { FixtureSchema } from "../db/import-fixtures";
export { ModeInput, PickInput, UndoInput } from "./pairwise";
