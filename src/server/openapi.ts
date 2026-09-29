import "server-only";
import { z } from "zod";
import * as In from "./dal/inputs";

// The API reference in one place: every JSON route with who may call it and the
// body it takes. The body schemas are the DAL's own validators, so the document
// cannot drift from what the server checks, and tests/api-registry.test.ts fails
// when a route file and this list disagree. Served as OpenAPI 3.1 at
// /api/openapi.json and read by people at /api-docs.

export type Access = "anyone" | "signed in" | "team member" | "captain" | "judge" | "voter" | "organizer" | "administrator";

export type Operation = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  tag: string;
  summary: string;
  access: Access;
  body?: z.ZodType;
  /** a file as the body instead of JSON: the media types it may be */
  upload?: readonly string[];
  ok?: number;
  /** extra refusals beyond the ones implied by access, path parameters and a body */
  also?: number[];
  /** implied refusals this operation never gives (a route that needs a session and nothing more refuses no one with 403) */
  never?: number[];
  /** answers besides ok and the refusals, each with what it means here */
  answers?: Record<number, string>;
  /** The media types of the success answer when it is not only JSON (the exports). */
  okTypes?: readonly string[];
  /** the body is read field by field, not validated as a whole: no 422 (the note says what a bad one gets) */
  lenient?: boolean;
  /** the body may be left out */
  bodyOptional?: boolean;
  note?: string;
};

const envelope = z.object({ record: z.record(z.string(), z.unknown()), signature: z.string() });
const credentials = z.object({ email: z.string(), password: z.string() });

export const OPERATIONS: Operation[] = [
  // Portal
  { method: "GET", path: "/api/health", tag: "Portal", summary: "Liveness and database check: { ok, events }", access: "anyone", answers: { 503: "Not ready: warming up, the data folder cannot be written, or no event yet; the same report with ok: false and the problem" } },
  { method: "GET", path: "/api/openapi.json", tag: "Portal", summary: "This document", access: "anyone" },
  { method: "GET", path: "/api/audit", tag: "Portal", summary: "The portal's own audit log: the entries no event owns (accounts, sign-ins, API tokens, the signing key, demo mode), newest first, each as a sentence with its row id and hash, and the chain's state; ?limit= up to 5000 (default 500)", access: "administrator" },

  // Accounts
  { method: "POST", path: "/api/auth/sign-up", tag: "Accounts", summary: "Create an account and sign in (sets the session cookie)", access: "anyone", body: In.SignUp, ok: 201, also: [403, 409, 429], note: "An address named in ADMIN_EMAILS signs up only with the one-time setup code from the server log (403 without it). One network address gets 300 sign-ups and password sign-ins per 10 minutes by default (SIGN_IN_LIMIT_PER_ADDRESS), then 429. A browser request from another origin is 403 cross_origin." },
  { method: "POST", path: "/api/auth/sign-in", tag: "Accounts", summary: "Sign in with email and password (sets the session cookie)", access: "anyone", body: credentials, lenient: true, also: [401, 403, 429], note: "A missing or wrong email or password is 401 bad_credentials, never 422. 403 cross_origin for a browser request from another origin (login CSRF)." },
  { method: "POST", path: "/api/auth/sign-out", tag: "Accounts", summary: "End the session the request carries, by cookie or Bearer: { signedOut, reason? }", access: "anyone", answers: { 303: "A browser's own form post (Accept: text/html, or Sec-Fetch-Mode: navigate) is sent to the front page instead" }, note: "A session token sent as Authorization: Bearer ends as the cookie's session does, and the session cookie is cleared either way. An API token is not a session and is not ended: the answer is { signedOut: false, reason } (revoke it at /account/tokens or with POST /api/tokens/{token}/revoke). The four checker sessions are never ended, by cookie or Bearer: the answer is signedOut: false with the reason (the cookie is still cleared)." },
  { method: "POST", path: "/api/auth/demo-sign-in", tag: "Accounts", summary: "While demo mode is on, sign in as one of the four demo identities, as the sign-in page's demo buttons do (sets the session cookie)", access: "anyone", body: z.object({ as: z.enum(["organizer", "judge_a", "judge_b", "participant"]) }), lenient: true, also: [403], note: "A label not among the four is 403 demo_sign_in_off too, never 422. 403 demo_sign_in_off when the portal runs with SEED_CHECKER_SESSIONS off (a real event), or refuses demo mode on a public address (unless PUBLIC_DEMO=true with an own secret). A browser request from another origin is 403 cross_origin." },

  { method: "GET", path: "/api/tokens", tag: "Accounts", summary: "Your API tokens (never the tokens themselves)", access: "signed in", note: "From a signed-in session; an API token cannot manage tokens." },
  {
    method: "POST",
    path: "/api/tokens",
    tag: "Accounts",
    summary: "Make an API token (returned once); it acts as you, with your permissions",
    access: "signed in",
    body: In.TokenInput,
    ok: 201,
    note: "From a signed-in session; an API token cannot manage tokens.",
  },
  { method: "POST", path: "/api/tokens/{token}/revoke", tag: "Accounts", summary: "Revoke one of your API tokens", access: "signed in", note: "From a signed-in session." },

  // Events
  { method: "GET", path: "/api/events", tag: "Events", summary: "Every event, public fields only", access: "anyone" },
  { method: "POST", path: "/api/events", tag: "Events", summary: "Create an event", access: "administrator", body: In.NewEvent, ok: 201 },
  { method: "GET", path: "/api/events/{event}", tag: "Events", summary: "One event, public fields only", access: "anyone" },
  { method: "PUT", path: "/api/events/{event}", tag: "Events", summary: "Save the event's name, description and dates", access: "organizer", body: In.Details, also: [409], note: "409 judging_started when the submission deadline would move later (or reopen) after a judge saved a review or answered a pairwise question; 409 results_published for the dates or the places that earn a certificate once results are out." },
  { method: "PUT", path: "/api/events/{event}/tracks", tag: "Events", summary: "Replace the event's tracks", access: "organizer", body: In.TrackRows, also: [409], note: "The rows in order, each with its id to keep a track (a row without one is a new track). A track with projects or judges cannot be removed (409 track_in_use). Once the results are published the tracks are final (409 results_published); sending them unchanged is still fine. The audit row keeps every track's id, name and position before and after." },
  { method: "PUT", path: "/api/events/{event}/prizes", tag: "Events", summary: "Replace the event's prizes", access: "organizer", body: In.PrizeRows, note: "A row keeps its prize by sending back that prize's id, once; a row without an id is a new prize, and a stored prize no row names is removed. Any other id (another event's, made up, removed since the caller read the prizes, or on two rows) is 422, its error keyed by the row's place (\"0\" for the first row) as a row's other errors are." },
  { method: "GET", path: "/api/events/{event}/project-fields", tag: "Events", summary: "What teams fill in on the project form: each built-in field (title, summary, trackId, description, repoUrl, videoUrl, liveUrl, thumbnailUrl, galleryUrls, tags) required, optional or hidden, and how many tracks the event has", access: "anyone" },
  {
    method: "PUT",
    path: "/api/events/{event}/project-fields",
    tag: "Events",
    summary: "Choose what teams fill in: any built-in field with required, optional or hidden; a field left out keeps its mode",
    access: "organizer",
    body: In.ProjectFieldsInput,
    note: "Answers the modes in force. A required field is refused on submit when empty (422, keyed by the field); the title and the track, when required, on every save. An optional title left empty is the team's name; while the title is hidden, every project is shown under its team's name (a title typed before stays stored). The track is never optional, and is hidden only while the event has one track (422 otherwise): the team then gets that track. A hidden field is ignored when a team sends it and is empty wherever the project is shown to others; what a team entered before stays stored and shows again if the field is turned back on.",
  },
  { method: "PUT", path: "/api/events/{event}/questions", tag: "Events", summary: "Replace the custom submission questions", access: "organizer", body: In.QuestionRows, also: [409], note: "409 question_answered: a question teams have answered cannot be removed; edit it instead." },
  { method: "PUT", path: "/api/events/{event}/rubric", tag: "Events", summary: "Replace the weighted scoring rubric", access: "organizer", body: In.RubricInput, also: [409], note: "The body is { criteria, reason }, or a bare list of rows (the rows with no reason). Once any score exists the set of criteria is fixed (409 rubric_in_use), and a weight change needs a reason (422 without one): it is audited and the published results list it (weightChanges). Labels and prompts can change until the results are published (409 results_published)." },
  { method: "GET", path: "/api/events/{event}/overview", tag: "Events", summary: "Progress, open decisions and the latest audit lines", access: "organizer" },
  { method: "GET", path: "/api/events/{event}/audit", tag: "Events", summary: "The event's audit log, newest first, as its log page shows it (a ballot's picks sealed until voting closes), each entry a sentence with its row id and hash, and the chain's state; ?limit= up to 5000 (default 500)", access: "organizer" },
  {
    method: "GET",
    path: "/api/events/{event}/export/{file}",
    tag: "Events",
    summary: "Export: scores.csv, projects.csv, normalized.csv, audit.csv, event.json, or fixtures.json (the import format)",
    access: "organizer",
    okTypes: ["text/csv", "application/json"],
    note: "Add ?bom=1 to a CSV for a UTF-8 byte-order mark, which Excel needs to read names outside ASCII; the portal's own download buttons do. scores.csv's last column, source, says whether each review arrived by an import (import) or was given out on this portal (portal). After publishing, normalized.csv is the published run as stored, not worked out again; a pairwise run has its own columns.",
  },

  {
    method: "POST",
    path: "/api/imports",
    tag: "Events",
    summary: "Import an event file in the fixture format (the fixtures.json export); importing twice changes nothing, a file for an event already here adds to it only for its organizers and never after its results are published (409), and ids another event holds are renamed (listed in renamed)",
    access: "administrator",
    body: In.FixtureSchema,
    ok: 201,
    also: [409, 413, 422],
    note: "The answer's added lists, and the import's audit row keeps, each account made a judge and each review brought in or added to, with its scores. Files up to 64 MB (413 above it), room for the portal's own export of an event of 1,000 projects and 8,000 reviews with every field at its longest. A caller who may not import is refused before the file is read. Ids are 1 to 80 letters, digits, '_', '-' or '.'; dates are ISO 8601 with a time zone; one file brings at most 100 tracks, 1,000 judges, 2,000 teams of up to 50 members, 2,000 projects and 16,000 reviews (split a bigger event over several files); anything else is a 422 naming the field. A new event whose name's web address is taken gets the next free one (slug in the answer). Into an event judges have scored, a file that would add a rubric criterion (in rubric or in a review's scores) or whose rubric leaves one out is 409 rubric_in_use; the event's own labels, prompts and weights always stay (skipped lists each one the file gives differently). A project's answers come in only with a project the import creates, never into one already here (skipped lists them). Into an event that is here, the forms' team rules hold, each a 409 naming the file's row: team_full (past the event's team size), team_has_project (a second project for a team), conflict_of_interest (a review by a judge on the project's team, or a member added to a team whose project they judge).",
  },
  { method: "POST", path: "/api/events/{event}/claims", tag: "Accounts", summary: "Personal links, returned once, for the people in the event without a password who hold no role and no team seat in any event you do not run; elsewhere lists the others, whom only an administrator's reset link reaches", access: "organizer", ok: 201, note: "With email on (SMTP_URL), each link is also mailed as it is made; the answer's mail says to whom and whether it went, and the outbox keeps the message with its link blanked." },
  { method: "GET", path: "/api/claims/{token}", tag: "Accounts", summary: "Whose personal link this is (410 once used or expired)", access: "anyone", also: [410] },
  { method: "POST", path: "/api/claims/{token}", tag: "Accounts", summary: "Set your password with your personal link and sign in", access: "anyone", body: In.ClaimInput, also: [403, 410], note: "A browser request from another origin is 403 cross_origin (login CSRF)." },
  { method: "POST", path: "/api/password-resets", tag: "Accounts", summary: "A one-time link for an account to set a new password, returned once (it works once, within a day)", access: "administrator", body: In.ResetLinkInput, ok: 201, also: [404, 409], note: "The four demo identities have no password to reset: 409 demo_account. With email on (SMTP_URL), the link is also mailed to the account's own address; the answer's mail says whether it went." },
  { method: "GET", path: "/api/password-resets/{token}", tag: "Accounts", summary: "Whose reset link this is (410 once used or expired)", access: "anyone", also: [410] },
  { method: "POST", path: "/api/password-resets/{token}", tag: "Accounts", summary: "Set a new password with a reset link and sign in; every other signed-in session of the account ends", access: "anyone", body: In.ResetInput, also: [403, 410], note: "A browser request from another origin is 403 cross_origin (login CSRF)." },

  // Teams and projects
  { method: "POST", path: "/api/events/{event}/teams", tag: "Teams and projects", summary: "Start a team (you become its captain)", access: "signed in", body: In.TeamName, ok: 201 },
  { method: "POST", path: "/api/teams/{team}/invite", tag: "Teams and projects", summary: "Make a new team invite code (the old one stops working)", access: "captain" },
  { method: "POST", path: "/api/teams/{team}/leave", tag: "Teams and projects", summary: "Leave the team while submissions are open (the captain hands the captaincy over first; the last member dissolves the team instead)", access: "team member", also: [409], note: "409 vote_would_change when the person has a community vote (not voided) for this team's project: votes for your own team are not counted, so the change would move the count; the pick comes off the ballot while voting is open, or an organizer voids the vote, first." },
  { method: "POST", path: "/api/teams/{team}/dissolve", tag: "Teams and projects", summary: "Dissolve the team while submissions are open, when you are its only member; a draft project is deleted with it", access: "team member", also: [409], note: "409 others_on_the_team while anyone else is on it; 409 project_submitted once its project is submitted (the team stays with it)." },
  { method: "DELETE", path: "/api/teams/{team}/members/{user}", tag: "Teams and projects", summary: "Take a member off the team while submissions are open", access: "captain", also: [409], note: "409 vote_would_change when the person has a community vote (not voided) for this team's project: votes for your own team are not counted, so the change would move the count; the pick comes off the ballot while voting is open, or an organizer voids the vote, first." },
  { method: "PUT", path: "/api/teams/{team}/name", tag: "Teams and projects", summary: "Rename the team: its members while submissions are open; after that an organizer, with a reason, until results are published", access: "team member", body: In.RenameInput, note: "An organizer renaming a team (after the close, or one they are not on) must give a reason (422 without one); the audit log records it as the organizers' change. 403 results_published once results are out." },
  { method: "POST", path: "/api/teams/{team}/members", tag: "Teams and projects", summary: "Put someone with an account on the team, with a reason, until results are published (after the close too)", access: "organizer", body: In.AddMemberInput, ok: 201, also: [409], note: "The rules of a join hold: 409 already_on_a_team (one team per person per event), team_full (the event's team size) or conflict_of_interest (they are assigned to judge this team's project), and 409 vote_would_change when the person has a community vote (not voided) for this team's project: votes for your own team are not counted, so the change would move the count; the pick comes off the ballot while voting is open, or an organizer voids the vote, first. 422 when no account has the address. 403 results_published once results are out: certificates name the members." },
  { method: "POST", path: "/api/teams/{team}/members/{user}/remove", tag: "Teams and projects", summary: "Take someone off the team, with a reason, until results are published (after the close too); a captain taken off hands the captaincy to the member who joined first", access: "organizer", body: In.RemoveMemberInput, also: [409], note: "409 last_member: a team is never left with nobody. 409 vote_would_change when the person has a community vote (not voided) for this team's project: votes for your own team are not counted, so the change would move the count; the pick comes off the ballot while voting is open, or an organizer voids the vote, first." },
  { method: "PUT", path: "/api/teams/{team}/captain", tag: "Teams and projects", summary: "Hand the captaincy to another member while submissions are open; the old captain becomes a member", access: "captain", body: In.CaptainInput, also: [409] },
  { method: "POST", path: "/api/join/{code}", tag: "Teams and projects", summary: "Join a team with its invite code", access: "signed in", also: [409], note: "403 already_on_a_team (one team per person per event), conflict_of_interest (you are assigned to judge this team's project) or while submissions are closed; 409 team_full at the event's team size; 409 vote_would_change when the person has a community vote (not voided) for this team's project: votes for your own team are not counted, so the change would move the count; the pick comes off the ballot while voting is open, or an organizer voids the vote, first." },
  { method: "GET", path: "/api/events/{event}/me", tag: "Teams and projects", summary: "Your team and project in this event", access: "signed in", never: [403, 429] },
  { method: "GET", path: "/api/events/{event}/projects", tag: "Teams and projects", summary: "The submitted projects (the gallery); ?q= to search them, ?track=<id> for one track", access: "anyone", also: [422], note: "q searches as the gallery's search box does: every word must appear in a project's title, team, track, id or tags, case and accents ignored (ecole finds École). track is a track id, as each project's trackId gives it; one the event does not have is 422, and so is a q over 200 characters. Only what the gallery shows is searched." },
  {
    method: "POST",
    path: "/api/events/{event}/projects",
    tag: "Teams and projects",
    summary: "Submit your team's project (403 once submissions close)",
    access: "team member",
    body: In.ProjectInput,
    ok: 201,
    also: [409],
    note: "409 team_has_project: a team has one project; edit it with PUT /api/projects/{project}.",
  },
  { method: "PUT", path: "/api/projects/{project}", tag: "Teams and projects", summary: "Edit your team's project until submissions close", access: "team member", body: In.ProjectInput, also: [409], note: "Which fields are required, optional or hidden is the event's choice (GET /api/events/{event}/project-fields); the body shown is an event's with the defaults. A hidden field is ignored and keeps what is stored; an answer to a custom question the body leaves out stays as stored and counts when the project is checked for submitting. 409 track_locked: once judges are assigned to the project in its track, only an organizer moves it." },
  {
    method: "POST",
    path: "/api/projects/{project}/image",
    tag: "Teams and projects",
    summary: "Upload the project's picture, the image file itself as the body; it becomes the gallery card's image",
    access: "team member",
    upload: ["image/png", "image/jpeg", "image/webp"],
    ok: 201,
    also: [413, 415],
    note: "PNG, JPEG or WebP, told by the file's first bytes rather than its name or Content-Type, at most 8 MB and 50 megapixels. It is drawn again from its pixels (upright, at most 1600 pixels a side, a WebP with no metadata), stored in the data volume and served at the /uploads/ address the answer gives. Until submissions close.",
  },
  { method: "DELETE", path: "/api/projects/{project}/image", tag: "Teams and projects", summary: "Take the project's picture down (an uploaded file is deleted)", access: "team member" },
  { method: "POST", path: "/api/projects/{project}/take-down-picture", tag: "Teams and projects", summary: "Take a project's picture down, uploaded or linked, with a reason for the audit log; at any time", access: "organizer", body: In.HideInput },

  // Judging
  { method: "GET", path: "/api/events/{event}/organizers", tag: "Events", summary: "The event's organizers", access: "organizer" },
  { method: "POST", path: "/api/events/{event}/organizers", tag: "Events", summary: "Make an existing account an organizer too (201 added, 200 already one; 403 account_in_other_event when it has a place in an event you do not run, unless you are an administrator)", access: "organizer", body: In.OrganizerInput, ok: 201, answers: { 200: "Already an organizer: nothing changed" }, also: [404] },
  { method: "DELETE", path: "/api/events/{event}/organizers/{user}", tag: "Events", summary: "Remove an organizer; the last one stays", access: "organizer", also: [404, 409] },
  { method: "GET", path: "/api/events/{event}/judges", tag: "Judging", summary: "Judges, invitations, tracks and loads", access: "organizer" },
  { method: "POST", path: "/api/events/{event}/judges/invites", tag: "Judging", summary: "Invite a judge: returns the invitation link once", access: "organizer", body: In.InviteInput, ok: 201, also: [409], note: "409 already_a_judge for an address that judges the event already. With email on (SMTP_URL), each link is also mailed as it is made; the answer's mail says to whom and whether it went, and the outbox keeps the message with its link blanked." },
  { method: "POST", path: "/api/events/{event}/judges/invites/batch", tag: "Judging", summary: "Invite many judges from a pasted list: one link each, returned once", access: "organizer", body: In.BatchInviteInput, ok: 201, note: "One judge per line: \"name, email\", \"email\", or a name alone for an open link; a third field names that line's own tracks, separated by \";\", else trackIds apply. Commas or tabs separate fields. Up to 200 lines; any bad line is a 422 naming its line, and nothing is made. An address that already judges the event is skipped (skipped lists it). One judge.invite audit row per link. With email on, each link with an address is mailed; mail says to whom and whether it went." },
  { method: "POST", path: "/api/events/{event}/judges/invites/{invite}/revoke", tag: "Judging", summary: "Revoke an unused invitation", access: "organizer", also: [409], note: "409 invite_used once accepted: remove the judge instead." },
  { method: "POST", path: "/api/judge-invites/{code}/accept", tag: "Judging", summary: "Accept a judge invitation", access: "signed in", also: [409], note: "409 invite_used for a link already used; 409 judge_removed when an organizer removed you as a judge of the event." },
  { method: "POST", path: "/api/events/{event}/judges/{judge}/remove", tag: "Judging", summary: "Remove a judge from the event, with a reason", access: "organizer", body: In.CorrectionInput, also: [409], note: "Their role and tracks end, so every judge route refuses them; open reviews they never started are withdrawn. Whatever they saved stays on record and leaves the ranking by an exclusion carrying the reason (the receipts name them as removed). Answers { removed, withdrawn, kept, voided }. 409 results_published after publishing." },
  { method: "PUT", path: "/api/events/{event}/judges/{judge}/tracks", tag: "Judging", summary: "Set which tracks a judge reviews", access: "organizer", body: In.TrackIds },
  {
    method: "POST",
    path: "/api/events/{event}/assignments/runs",
    tag: "Judging",
    summary: "Run the seeded assignment engine (mode fresh, or topup for new projects and judges)",
    access: "organizer",
    body: In.RunInput,
    ok: 201,
    also: [409],
  },
  { method: "POST", path: "/api/events/{event}/assignments", tag: "Judging", summary: "Assign one project to one judge by hand, with a reason", access: "organizer", body: In.ManualInput, ok: 201, also: [409], note: "A judge from another track gets the project's track added to theirs, so no judge sees a project outside their tracks; that grant is audited as its own judge.tracks row (via assignment.by_hand, with the project and the reason), and the judges list marks the track byHand." },
  { method: "POST", path: "/api/events/{event}/assignments/{assignment}/remove", tag: "Judging", summary: "Take back an assignment its judge has saved nothing on, with a reason", access: "organizer", body: In.CorrectionInput, also: [409], note: "409 review_started once the judge saved anything on it (in pairwise mode: answered a question about its project), 409 recused for a declared conflict, 409 results_published after publishing. Runs never give the pair back; an organizer still can by hand." },
  { method: "POST", path: "/api/events/{event}/assignments/{assignment}/undo-recusal", tag: "Judging", summary: "Give a recused review back to its judge, with a reason", access: "organizer", body: In.CorrectionInput, also: [409], note: "The review comes back as it was (finished if it was). A review that is not recused changes nothing. 409 when the person is no longer a judge, or after publishing." },
  { method: "POST", path: "/api/events/{event}/projects/{project}/track", tag: "Judging", summary: "Move a project to another track, with a reason", access: "organizer", body: In.MoveInput, also: [409], note: "Open reviews nobody started, by judges who do not judge the new track, are withdrawn; finished reviews stay and count; started ones stay in the record, out of their judge's console. Answers { moved, trackId, withdrawn, finishedKept, startedKept }; run a top-up next. 409 merged_copy for a merged duplicate, 409 results_published after publishing." },
  { method: "GET", path: "/api/events/{event}/projects/{project}/judging", tag: "Judging", summary: "One project's track and every judge assigned to it: started or not, in their tracks or not, recused with the judge's reason", access: "organizer" },
  { method: "GET", path: "/api/judge/{event}/console", tag: "Judging", summary: "Your assignments, rubric, scores and ranking so far", access: "judge" },
  {
    method: "GET",
    path: "/api/judge/scores",
    tag: "Judging",
    summary: "Your own scores; ?judge=<id> for anyone else's is refused with 403, never answered with yours",
    access: "judge",
    also: [422],
    note: "One ?judge= at a time: the parameter given twice is 422.",
  },
  { method: "PUT", path: "/api/judge/reviews/{assignment}", tag: "Judging", summary: "Save a review (autosave; submitted: true finishes it)", access: "judge", body: In.ReviewInput },
  { method: "POST", path: "/api/judge/reviews/{assignment}/recuse", tag: "Judging", summary: "Declare a conflict: the project leaves your list", access: "judge", body: In.RecuseInput },
  { method: "GET", path: "/api/judge/{event}/pairwise", tag: "Judging", summary: "Pairwise mode: your lists so far and the question to answer next, per track", access: "judge" },
  {
    method: "POST",
    path: "/api/judge/{event}/pairwise/pick",
    tag: "Judging",
    summary: "Pairwise mode: answer the current question (409 if it is not the current one)",
    access: "judge",
    body: In.PickInput,
    also: [409],
  },
  { method: "POST", path: "/api/judge/{event}/pairwise/undo", tag: "Judging", summary: "Pairwise mode: take back your latest answer in a track", access: "judge", body: In.UndoInput, also: [409], note: "409 nothing_to_undo when the track has no answer of yours." },

  // Results
  { method: "GET", path: "/api/events/{event}/normalization", tag: "Results", summary: "The normalization run with its working, judge by judge", access: "organizer", note: "Worked out again on every read. After publishing, published gives the stored run's id and time and differs lists each project whose score or rank here differs from it (empty unless the engine changed since); the published ranking is the stored run, as normalized.csv and the public results give it." },
  { method: "GET", path: "/api/events/{event}/pairwise", tag: "Results", summary: "The live pairwise ranking: receipts, the two pulls and the flagged judges", access: "organizer" },
  { method: "PUT", path: "/api/events/{event}/judge-ranking", tag: "Results", summary: "Whether each judge's console shows their own ranking so far (409 once published)", access: "organizer", body: In.RankingInput, also: [409], note: "Answers { show, changed }: saving what the event already has writes no audit row." },
  { method: "PUT", path: "/api/events/{event}/judging-mode", tag: "Results", summary: "How the judges judge: scores or pairwise (409 once published)", access: "organizer", body: In.ModeInput, also: [409], note: "Answers { mode, changed }: saving the mode the event already has changes nothing, needs no reason and writes no audit row (changed: false); a switch needs its reason (422 without)." },
  {
    method: "POST",
    path: "/api/events/{event}/judges/{judge}/override",
    tag: "Results",
    summary: "Reinstate a flagged judge or leave one out, with a reason",
    access: "organizer",
    body: In.OverrideInput.pick({ mode: true, reason: true }),
    also: [409],
  },
  { method: "DELETE", path: "/api/events/{event}/judges/{judge}/override", tag: "Results", summary: "Undo the override on a judge", access: "organizer", also: [409] },
  { method: "POST", path: "/api/events/{event}/duplicates/merge", tag: "Results", summary: "Merge a duplicate entry into the copy to keep", access: "organizer", body: In.MergeInput, also: [409] },
  { method: "POST", path: "/api/events/{event}/duplicates/unmerge", tag: "Results", summary: "Undo a merge", access: "organizer", body: In.UnmergeInput, also: [409] },
  { method: "POST", path: "/api/events/{event}/duplicates/not-duplicate", tag: "Results", summary: "Rule two flagged projects different, with a reason", access: "organizer", body: In.PairInput, also: [409] },
  { method: "POST", path: "/api/events/{event}/duplicates/not-duplicate/undo", tag: "Results", summary: "Undo a 'different projects' ruling", access: "organizer", body: In.UndoPairInput, also: [409] },
  {
    method: "POST",
    path: "/api/events/{event}/projects/{project}/accept-under-reviewed",
    tag: "Results",
    summary: "Publish a project with fewer than two reviews as it is, with a reason",
    access: "organizer",
    body: In.AcceptInput.pick({ reason: true }),
    also: [409],
  },
  {
    method: "DELETE",
    path: "/api/events/{event}/projects/{project}/accept-under-reviewed",
    tag: "Results",
    summary: "Undo publishing a project as it is",
    access: "organizer",
    also: [409],
  },
  {
    method: "POST",
    path: "/api/events/{event}/publish",
    tag: "Results",
    summary: "Publish the results (409 while submissions or decisions are open); an open community vote closes with it",
    access: "organizer",
    body: In.PublishInput,
    bodyOptional: true,
    also: [409, 422],
    note: "No body is needed. In pairwise mode, a ranking fit that stopped at its step limit before settling is refused (409 fit_not_settled) unless the body gives { reason }; the reason is stored with the run and shown on the results.",
  },
  { method: "GET", path: "/api/events/{event}/results", tag: "Results", summary: "The published results per track, or { published: false }", access: "anyone", note: "Also lists weightChanges (rubric weights changed after judging began) and trackMoves (projects the organizers moved to another track after judges were assigned: from, to, reason, at), each as the published run recorded it. evidence is how the ranking was reached, in totals read from the published run: projects placed and how many stand at a different place in their track than the plain figure gives them, judges left out (a count), and per method the leniency correction (k; judges counted, corrected by at least 0.005 points, the largest and median correction) and the signal check, or the pairwise answers, the pairs implied by scores and the judges who gave them, and the two pulls the fit measured and corrected for (null when too few answers measured one). It never names a judge or carries a judge's id." },

  // Community vote
  { method: "GET", path: "/api/events/{event}/voting", tag: "Community vote", summary: "Voting settings, turnout, suspected duplicates and the count, live while the window is open", access: "organizer" },
  { method: "PUT", path: "/api/events/{event}/voting", tag: "Community vote", summary: "Set the voting window, the ways in, the votes per voter, whether open-link ballots add to the result, and how many new open-link ballots one network address may start per hour", access: "organizer", body: In.SettingsInput, also: [409, 422], note: "Once the window has closed the count is final: 409 voting_closed. Whether open-link ballots add to the result (countLink; left out, it stays as it is) is fixed from the first ballot on: 409 count_rule_fixed. From the first ballot on, changing who may vote (modes) or the votes per voter needs a reason (422 without one): the change is audited as voting.rules_changed (a window moved, or a new linkPerAddress, in the same save gets its own voting.settings row) and the count, public and the organizers', lists it (ruleChanges). linkPerAddress (1 to 5000, default 8; left out, it stays as it is): raise it for a venue where everyone shares one wifi; it is audited and needs no reason." },
  { method: "POST", path: "/api/events/{event}/voting/link", tag: "Community vote", summary: "Make a new open voting link (the old one stops working)", access: "organizer", ok: 201, also: [409] },
  { method: "POST", path: "/api/events/{event}/voting/voters", tag: "Community vote", summary: "Add people to the voter list: one personal link each, returned once", access: "organizer", body: In.VoterList, ok: 201, also: [409], note: "With email on (SMTP_URL), each link is also mailed as it is made; the answer's mail says to whom and whether it went, and the outbox keeps the message with its link blanked." },
  {
    method: "POST",
    path: "/api/events/{event}/voting/voters/new-link",
    tag: "Community vote",
    summary: "A new personal link for one address on the voter list, returned once; the old link stops working",
    access: "organizer",
    body: In.VoterAddress,
    ok: 201,
    also: [404, 409],
    note: "For a link that was mistyped, bounced or lost. An address not on the list is 404; a ballot set aside is 409 voter_set_aside until it is counted again. With email on (SMTP_URL), the new link is also mailed; the answer's mail says whether it went.",
  },
  {
    method: "POST",
    path: "/api/events/{event}/voting/voters/{voter}/void",
    tag: "Community vote",
    summary: "Set a ballot aside as a suspected duplicate, with a reason",
    access: "organizer",
    body: In.VoidInput.pick({ reason: true }),
    also: [409],
  },
  { method: "POST", path: "/api/events/{event}/voting/voters/{voter}/restore", tag: "Community vote", summary: "Count a set-aside ballot again", access: "organizer", also: [409] },
  { method: "POST", path: "/api/vote/{code}", tag: "Community vote", summary: "Enter voting with an open or personal link (sets the voter cookie)", access: "anyone", also: [403, 429], note: "One ballot per browser: a browser that already holds a ballot in the event (its voter cookie) gets that ballot back instead of a new one. A new entry through the open link after the window closed is 403 voting_closed; a browser request from another origin is 403 cross_origin." },
  { method: "GET", path: "/api/events/{event}/ballot", tag: "Community vote", summary: "Your ballot: the projects in your own shuffled order, and your picks", access: "anyone" },
  { method: "PUT", path: "/api/events/{event}/ballot", tag: "Community vote", summary: "Replace your picks while the window is open", access: "voter", body: In.BallotInput, also: [409, 429], note: "409 already_voted: someone who voted one way (signed in, or with a personal link) changes the picks there, not with a second ballot. 403 outside the window or for a ballot set aside; 422 over the votes per voter or for a project of your own team." },
  { method: "GET", path: "/api/events/{event}/community", tag: "Community vote", summary: "The community count: null for everyone here until the window closes (organizers see it live on /voting)", access: "anyone", note: "ruleChanges lists every change to who may vote or the votes per voter made after the first ballot, with the organizers' reason. countChanges lists every duplicate merge or unmerge made after the window closed that moved the count: which copies, and each project's votes before and after (null: a merged copy, with no row of its own)." },

  // Comments
  { method: "GET", path: "/api/projects/{project}/comments", tag: "Comments", summary: "A project's comments; hidden ones keep their place and reason", access: "anyone", never: [404], note: "An unknown project has no comments: 200 with an empty list." },
  { method: "POST", path: "/api/projects/{project}/comments", tag: "Comments", summary: "Comment on a submitted project", access: "signed in", body: In.CommentInput, ok: 201, also: [429] },
  { method: "DELETE", path: "/api/comments/{comment}", tag: "Comments", summary: "Delete your own comment, for good (the audit log keeps that it was, not its words)", access: "signed in", note: "403 not_your_comment for anyone but its author; 403 comment_hidden while the organizers keep it hidden." },
  { method: "POST", path: "/api/comments/{comment}/unhide", tag: "Comments", summary: "Show a hidden comment again", access: "organizer" },
  { method: "POST", path: "/api/comments/{comment}/hide", tag: "Comments", summary: "Hide a comment, with a reason shown in its place", access: "organizer", body: In.HideInput },

  // Webhooks
  { method: "GET", path: "/api/events/{event}/webhooks", tag: "Webhooks", summary: "The event's webhooks and their delivery counts", access: "organizer" },
  {
    method: "POST",
    path: "/api/events/{event}/webhooks",
    tag: "Webhooks",
    summary: "Add a webhook for some audited actions or all (\"*\"); its signing secret comes back this once",
    access: "organizer",
    body: In.WebhookInput,
    ok: 201,
    also: [422],
    note: "A URL that resolves to a private or local address (this machine, the local network) is refused with 422, so a webhook never reaches the portal's own network; the address is checked again before every delivery. WEBHOOKS_ALLOW_PRIVATE=true lets an operator send to a receiver on their own network. A webhook subscribed to voting.settings also receives voting.rules_changed: the settings save that changes who may vote or the votes per voter once ballots are in, with its reason. Each delivery is a POST signed Dogfood-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of '<t>.<body>' keyed with the secret>; a receiver computes it again, compares in constant time and refuses a t more than five minutes from its clock (a replayed delivery). A retry carries the same Dogfood-Delivery id.",
  },
  { method: "POST", path: "/api/events/{event}/webhooks/{webhook}/disable", tag: "Webhooks", summary: "Turn a webhook off", access: "organizer" },
  { method: "POST", path: "/api/events/{event}/webhooks/{webhook}/enable", tag: "Webhooks", summary: "Turn a webhook back on", access: "organizer" },
  { method: "POST", path: "/api/events/{event}/webhooks/{webhook}/rotate-secret", tag: "Webhooks", summary: "Replace the signing secret (returned once)", access: "organizer" },
  { method: "POST", path: "/api/events/{event}/webhooks/{webhook}/test", tag: "Webhooks", summary: "Send a webhook.test delivery to this webhook", access: "organizer", also: [422] },
  { method: "GET", path: "/api/events/{event}/webhooks/{webhook}/deliveries", tag: "Webhooks", summary: "The last 50 deliveries: payload, answer, attempts", access: "organizer" },
  {
    method: "POST",
    path: "/api/events/{event}/webhooks/{webhook}/deliveries/{delivery}/retry",
    tag: "Webhooks",
    summary: "Send a delivery again",
    access: "organizer",
    also: [422],
  },

  // Email
  { method: "GET", path: "/api/events/{event}/outbox", tag: "Email", summary: "The messages the portal mailed for the event, or would have mailed while email is off, newest first, a page at a time", access: "organizer", also: [422], note: "Query: limit (1 to 500, default 100) and before (a message id: the page starts after it). The answer's next is the id to pass as before for the older page, null at the end; counts (total, sent, failed) are over every message. A before that names no message of this event is 422." },

  // Records
  { method: "GET", path: "/api/events/{event}/records", tag: "Records", summary: "Every signed record issued for the event", access: "organizer" },
  {
    method: "POST",
    path: "/api/events/{event}/records",
    tag: "Records",
    summary: "Your own judging record or certificate: 201 when issued now, 200 when it existed",
    access: "signed in",
    body: In.RecordRequest,
    ok: 201,
    answers: { 200: "The record existed already: the same one again" },
    note: "403 when there is no such record of yours: a judging record needs a judge of the event with a finished review or a pairwise answer, a certificate a member of a team that submitted, and both need the results published. 422 when kind is not judge or participant.",
  },
  { method: "POST", path: "/api/events/{event}/records/all", tag: "Records", summary: "Issue every record not issued yet", access: "organizer" },
  { method: "GET", path: "/api/records/{record}", tag: "Records", summary: "One signed record and the portal's check of it", access: "anyone" },
  { method: "POST", path: "/api/records/verify", tag: "Records", summary: "Check any signed record against the published keys", access: "anyone", body: envelope, lenient: true, note: "Any body answers 200: { valid: true, keyId }, or { valid: false, reason, message } with reason malformed, unknown_key or bad_signature. Open to any origin." },
  { method: "GET", path: "/.well-known/dogfood-keys.json", tag: "Records", summary: "The public keys that sign records (Ed25519, JWK), open to any origin", access: "anyone" },
];

const WHO: Record<Access, string> = {
  anyone: "Anyone, no session needed.",
  "signed in": "Any signed-in person.",
  "team member": "A member of a team in this event.",
  captain: "The team's captain.",
  judge: "A judge of this event, for their own work only.",
  voter: "A voter: the voting-link cookie or, where the event allows accounts, a session.",
  organizer: "The event's organizers.",
  administrator: "A portal administrator.",
};

const REFUSAL: Record<number, string> = {
  401: "No valid session (or voter link)",
  403: "Signed in, but not allowed; the reason is in the error code",
  404: "No such item",
  409: "Not possible in the current state",
  410: "The link was used already or has expired",
  413: "The body is too large",
  415: "The body is not a kind of file this operation takes",
  422: "The body or a query parameter failed validation; details lists the fields or parameters (a body of the wrong shape as a whole under request)",
  429: "Too many requests; wait the Retry-After seconds (also once a signed-in person has been refused 60 times in ten minutes)",
  503: "Not ready yet; try again shortly",
};

/** What each status means in general, for the reference's table of answers; an operation's own answers say more. */
export const STATUS_MEANING: Record<number, string> = {
  200: "OK",
  201: "Created",
  303: "See Other: a browser is sent on to a page",
  ...REFUSAL,
};

export function operationId(op: Operation): string {
  const words = op.path
    .replace(/^\/(api|\.well-known)\//, "")
    .split(/[/.{}-]+/)
    .filter(Boolean);
  return [op.method.toLowerCase(), ...words.map((w) => w[0]!.toUpperCase() + w.slice(1))].join("");
}

function schemaOf(body: z.ZodType) {
  return z.toJSONSchema(body, { io: "input", unrepresentable: "any" });
}

export function openApiDocument(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    const refusals = new Set<number>(op.also ?? []);
    // a caller refused (403) past the per-person limit is answered 429 instead (src/server/mutate.ts)
    if (op.access !== "anyone") refusals.add(401).add(403).add(429);
    if (params.length) refusals.add(404);
    if (op.body && !op.lenient) refusals.add(422);
    for (const code of op.never ?? []) refusals.delete(code);
    const ok = op.ok ?? 200;
    for (const code of [ok, ...refusals]) if (!STATUS_MEANING[code]) throw new Error(`${op.method} ${op.path}: status ${code} has no meaning in STATUS_MEANING (src/server/openapi.ts)`);
    paths[op.path] ??= {};
    paths[op.path]![op.method.toLowerCase()] = {
      operationId: operationId(op),
      tags: [op.tag],
      summary: op.summary,
      description: `Who may call it: ${WHO[op.access]}${op.note ? ` ${op.note}` : ""}`,
      ...(params.length ? { parameters: params.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })) } : {}),
      ...(op.body ? { requestBody: { required: !op.bodyOptional, content: { "application/json": { schema: schemaOf(op.body) } } } } : {}),
      ...(op.upload
        ? { requestBody: { required: true, content: Object.fromEntries(op.upload.map((type) => [type, { schema: { type: "string", contentMediaType: type } }])) } }
        : {}),
      responses: {
        [ok]: {
          description: STATUS_MEANING[ok],
          ...(op.okTypes ? { content: Object.fromEntries(op.okTypes.map((type) => [type, { schema: { type: "string" } }])) } : {}),
        },
        ...Object.fromEntries(Object.entries(op.answers ?? {}).map(([code, description]) => [code, { description }])),
        ...Object.fromEntries(
          [...refusals].sort().map((code) => [code, { description: REFUSAL[code], content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }]),
        ),
      },
      security: op.access === "anyone" ? [] : [{ session: [] }, { bearer: [] }],
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Dogfood portal API",
      version: "1.0.0",
      description:
        "Every action in the portal's interface, over HTTP: JSON in and out, and text/csv for the CSV exports. Authenticate with the session cookie, or with Authorization: Bearer <token>: an API token (made at /account/tokens or POST /api/tokens) or a session token. " +
        "Refusals are real 401 and 403 answers with a JSON error code, never redirects. Every refusal is JSON; the CSV exports answer text/csv. " +
          "The one redirect is sign-out's, for a browser's own form post: a request with Accept: text/html or Sec-Fetch-Mode: navigate is sent to the front page (303).",
    },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "session" },
        bearer: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "message"],
          properties: { error: { type: "string", description: "A stable code, e.g. not_an_organizer" }, message: { type: "string" }, details: { type: "object" } },
        },
      },
    },
  };
}
