import "server-only";

// Every request body the DAL validates, by name: the one source for the API
// reference (src/server/openapi.ts), so the documented shapes are the checked ones.

export { SignUp } from "./accounts";
export { ManualInput, RunInput } from "./assignments";
export { CommentInput, HideInput } from "./comments";
export { InviteInput, TrackIds } from "./judges";
export { AcceptInput, MergeInput, OverrideInput, PairInput, RevokeInput, UndoPairInput, UnmergeInput } from "./normalization";
export { Details, NewEvent, PrizeRows, QuestionRows, RubricRows, TrackRows } from "./organize";
export { ProjectInput } from "./projects";
export { RecordRequest } from "./records";
export { RecuseInput, ReviewInput } from "./reviews";
export { TeamName } from "./teams";
export { BallotInput, RestoreInput, SettingsInput, VoidInput, VoterList } from "./voting";
export { WebhookInput } from "./webhooks";
export { ClaimInput } from "./claims";
export { TokenInput } from "./tokens";
export { OrganizerInput } from "./organizers";
export { FixtureSchema } from "../db/import-fixtures";
