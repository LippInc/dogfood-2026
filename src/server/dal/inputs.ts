import "server-only";

// Every request body the DAL validates, by name: the one source for the API
// reference (src/server/openapi.ts), so the documented shapes are the checked ones.

export { SignUp } from "./accounts";
export { ManualInput, RunInput } from "./assignments";
export { CorrectionInput, MoveInput } from "./corrections";
export { CommentInput, HideInput } from "./comments";
export { BatchInviteInput, InviteInput, RankingInput, TrackIds } from "./judges";
export { AcceptInput, MergeInput, OverrideInput, PairInput, RevokeInput, UndoPairInput, UnmergeInput } from "./decisions";
export { Details, NewEvent, PrizeRows, QuestionRows, RubricBody, RubricInput, RubricRows, TrackRows } from "./organize";
export { ProjectInput } from "./projects";
export { GalleryInput, TakeDownInput } from "./project-image";
export { ProjectFieldsInput } from "./project-fields";
export { RecordRequest } from "./records";
export { RecuseInput, ReviewInput } from "./reviews";
export { AddMemberInput, CaptainInput, RemoveMemberInput, RenameInput, TeamName } from "./teams";
export { BallotInput } from "./voting";
export { RestoreInput, SettingsInput, VoidInput, VoterAddress, VoterList } from "./voting-organizer";
export { WebhookInput } from "./webhooks";
export { ClaimInput } from "./claims";
export { ResetInput, ResetLinkInput } from "./password-resets";
export { TokenInput } from "./tokens";
export { OrganizerInput } from "./organizers";
export { FixtureSchema } from "../db/import-fixtures";
export { ModeInput, PickInput, UndoInput } from "./pairwise";
export { TieBreakInput } from "./tiebreak";
export { PublishInput } from "./results";
export { AwardInput } from "./prize-awards";
export { UpdateEdit, UpdateInput } from "./updates";
export { ReminderInput } from "./reminders";
export { CloseCallInput } from "./close-calls";
export { CloseFinalsInput, FinalistInput, FinalsScoreInput, OpenFinalsInput, PanelInput, RemoveFinalistInput } from "./finals";
