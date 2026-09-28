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
  note?: string;
};

const envelope = z.object({ record: z.record(z.string(), z.unknown()), signature: z.string() });
const credentials = z.object({ email: z.string(), password: z.string() });

export const OPERATIONS: Operation[] = [
  // Portal
  { method: "GET", path: "/api/health", tag: "Portal", summary: "Liveness and database check", access: "anyone" },
  { method: "GET", path: "/api/openapi.json", tag: "Portal", summary: "This document", access: "anyone" },
  { method: "GET", path: "/api/audit", tag: "Portal", summary: "The portal's own audit log: the entries no event owns (accounts, sign-ins, API tokens, the signing key, demo mode), newest first, each as a sentence with its row id and hash, and the chain's state; ?limit= up to 5000 (default 500)", access: "administrator" },

  // Accounts
  { method: "POST", path: "/api/auth/sign-up", tag: "Accounts", summary: "Create an account and sign in (sets the session cookie)", access: "anyone", body: In.SignUp, ok: 201, also: [403, 409, 429], note: "An address named in ADMIN_EMAILS signs up only with the one-time setup code from the server log (403 without it). One network address gets 60 sign-ups and password sign-ins per 10 minutes (429). A browser request from another origin is 403 cross_origin." },
  { method: "POST", path: "/api/auth/sign-in", tag: "Accounts", summary: "Sign in with email and password (sets the session cookie)", access: "anyone", body: credentials, also: [401, 403, 429], note: "403 cross_origin for a browser request from another origin (login CSRF)." },
  { method: "POST", path: "/api/auth/sign-out", tag: "Accounts", summary: "End the session", access: "anyone" },
  { method: "POST", path: "/api/auth/demo-sign-in", tag: "Accounts", summary: "While demo mode is on, sign in as one of the four demo identities, as the sign-in page's demo buttons do (sets the session cookie)", access: "anyone", body: z.object({ as: z.enum(["organizer", "judge_a", "judge_b", "participant"]) }), also: [403], note: "403 demo_sign_in_off when the portal runs with SEED_CHECKER_SESSIONS off (a real event), or refuses demo mode on a public address (unless PUBLIC_DEMO=true with an own secret). A browser request from another origin is 403 cross_origin." },

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
  { method: "PUT", path: "/api/events/{event}", tag: "Events", summary: "Save the event's name, description and dates", access: "organizer", body: In.Details },
  { method: "PUT", path: "/api/events/{event}/tracks", tag: "Events", summary: "Replace the event's tracks", access: "organizer", body: In.TrackRows },
  { method: "PUT", path: "/api/events/{event}/prizes", tag: "Events", summary: "Replace the event's prizes", access: "organizer", body: In.PrizeRows },
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
  { method: "PUT", path: "/api/events/{event}/questions", tag: "Events", summary: "Replace the custom submission questions", access: "organizer", body: In.QuestionRows },
  { method: "PUT", path: "/api/events/{event}/rubric", tag: "Events", summary: "Replace the weighted scoring rubric", access: "organizer", body: In.RubricBody, also: [409], note: "The body is { criteria, reason }; a bare list of rows still works. Once any score exists the set of criteria is fixed (409 rubric_in_use), and a weight change needs a reason (422 without one): it is audited and the published results list it (weightChanges). Labels and prompts can change until the results are published (409 results_published)." },
  { method: "GET", path: "/api/events/{event}/overview", tag: "Events", summary: "Progress, open decisions and the latest audit lines", access: "organizer" },
  { method: "GET", path: "/api/events/{event}/audit", tag: "Events", summary: "The event's audit log, newest first, as its log page shows it (a ballot's picks sealed until voting closes), each entry a sentence with its row id and hash, and the chain's state; ?limit= up to 5000 (default 500)", access: "organizer" },
  {
    method: "GET",
    path: "/api/events/{event}/export/{file}",
    tag: "Events",
    summary: "Export: scores.csv, projects.csv, normalized.csv, audit.csv, event.json, or fixtures.json (the import format)",
    access: "organizer",
    note: "Add ?bom=1 to a CSV for a UTF-8 byte-order mark, which Excel needs to read names outside ASCII; the portal's own download buttons do.",
  },

  {
    method: "POST",
    path: "/api/imports",
    tag: "Events",
    summary: "Import an event file in the fixture format (the fixtures.json export); importing twice changes nothing, a file for an event already here adds to it only for its organizers and never after its results are published (409), and ids another event holds are renamed (listed in renamed)",
    access: "administrator",
    body: In.FixtureSchema,
    ok: 201,
    also: [409, 413],
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
  { method: "POST", path: "/api/teams/{team}/leave", tag: "Teams and projects", summary: "Leave the team while submissions are open (the captain hands the captaincy over first; the last member dissolves the team instead)", access: "team member", also: [409] },
  { method: "POST", path: "/api/teams/{team}/dissolve", tag: "Teams and projects", summary: "Dissolve the team while submissions are open, when you are its only member; a draft project is deleted with it", access: "team member", also: [409], note: "409 others_on_the_team while anyone else is on it; 409 project_submitted once its project is submitted (the team stays with it)." },
  { method: "DELETE", path: "/api/teams/{team}/members/{user}", tag: "Teams and projects", summary: "Take a member off the team while submissions are open", access: "captain", also: [409] },
  { method: "PUT", path: "/api/teams/{team}/name", tag: "Teams and projects", summary: "Rename the team: its members while submissions are open; after that an organizer, with a reason, until results are published", access: "team member", body: In.RenameInput, note: "An organizer renaming a team (after the close, or one they are not on) must give a reason (422 without one); the audit log records it as the organizers' change. 403 results_published once results are out." },
  { method: "POST", path: "/api/teams/{team}/members", tag: "Teams and projects", summary: "Put someone with an account on the team, with a reason, until results are published (after the close too)", access: "organizer", body: In.AddMemberInput, ok: 201, also: [409], note: "The rules of a join hold: 409 already_on_a_team (one team per person per event), team_full (the event's team size) or conflict_of_interest (they are assigned to judge this team's project). 422 when no account has the address. 403 results_published once results are out: certificates name the members." },
  { method: "POST", path: "/api/teams/{team}/members/{user}/remove", tag: "Teams and projects", summary: "Take someone off the team, with a reason, until results are published (after the close too); a captain taken off hands the captaincy to the member who joined first", access: "organizer", body: In.RemoveMemberInput, also: [409], note: "409 last_member: a team is never left with nobody." },
  { method: "PUT", path: "/api/teams/{team}/captain", tag: "Teams and projects", summary: "Hand the captaincy to another member while submissions are open; the old captain becomes a member", access: "captain", body: In.CaptainInput, also: [409] },
  { method: "POST", path: "/api/join/{code}", tag: "Teams and projects", summary: "Join a team with its invite code", access: "signed in" },
  { method: "GET", path: "/api/events/{event}/me", tag: "Teams and projects", summary: "Your team and project in this event", access: "signed in" },
  { method: "GET", path: "/api/events/{event}/projects", tag: "Teams and projects", summary: "The submitted projects (the gallery)", access: "anyone" },
  {
    method: "POST",
    path: "/api/events/{event}/projects",
    tag: "Teams and projects",
    summary: "Submit your team's project (403 once submissions close)",
    access: "team member",
    body: In.ProjectInput,
    ok: 201,
  },
  { method: "PUT", path: "/api/projects/{project}", tag: "Teams and projects", summary: "Edit your team's project until submissions close", access: "team member", body: In.ProjectInput, note: "Which fields are required, optional or hidden is the event's choice (GET /api/events/{event}/project-fields); the body shown is an event's with the defaults. A hidden field is ignored and keeps what is stored." },
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
  { method: "POST", path: "/api/events/{event}/organizers", tag: "Events", summary: "Make an existing account an organizer too (201 added, 200 already one; 403 account_in_other_event when it has a place in an event you do not run, unless you are an administrator)", access: "organizer", body: In.OrganizerInput, ok: 201, also: [404] },
  { method: "DELETE", path: "/api/events/{event}/organizers/{user}", tag: "Events", summary: "Remove an organizer; the last one stays", access: "organizer", also: [404, 409] },
  { method: "GET", path: "/api/events/{event}/judges", tag: "Judging", summary: "Judges, invitations, tracks and loads", access: "organizer" },
  { method: "POST", path: "/api/events/{event}/judges/invites", tag: "Judging", summary: "Invite a judge: returns the invitation link once", access: "organizer", body: In.InviteInput, ok: 201, note: "With email on (SMTP_URL), each link is also mailed as it is made; the answer's mail says to whom and whether it went, and the outbox keeps the message with its link blanked." },
  { method: "POST", path: "/api/events/{event}/judges/invites/{invite}/revoke", tag: "Judging", summary: "Revoke an unused invitation", access: "organizer" },
  { method: "POST", path: "/api/judge-invites/{code}/accept", tag: "Judging", summary: "Accept a judge invitation", access: "signed in" },
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
  { method: "POST", path: "/api/events/{event}/assignments", tag: "Judging", summary: "Assign one project to one judge by hand, with a reason", access: "organizer", body: In.ManualInput, ok: 201, also: [409] },
  { method: "GET", path: "/api/judge/{event}/console", tag: "Judging", summary: "Your assignments, rubric, scores and ranking so far", access: "judge" },
  {
    method: "GET",
    path: "/api/judge/scores",
    tag: "Judging",
    summary: "Your own scores; ?judge=<id> for anyone else's is refused with 403, never answered with yours",
    access: "judge",
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
  },
  { method: "POST", path: "/api/judge/{event}/pairwise/undo", tag: "Judging", summary: "Pairwise mode: take back your latest answer in a track", access: "judge", body: In.UndoInput },

  // Results
  { method: "GET", path: "/api/events/{event}/normalization", tag: "Results", summary: "The normalization run with its working, judge by judge", access: "organizer" },
  { method: "GET", path: "/api/events/{event}/pairwise", tag: "Results", summary: "The live pairwise ranking: receipts, the two pulls and the flagged judges", access: "organizer" },
  { method: "PUT", path: "/api/events/{event}/judging-mode", tag: "Results", summary: "How the judges judge: scores or pairwise (409 once published)", access: "organizer", body: In.ModeInput, note: "Answers { mode, changed }: saving the mode the event already has changes nothing and writes no audit row (changed: false)." },
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
    also: [409],
  },
  { method: "GET", path: "/api/events/{event}/results", tag: "Results", summary: "The published results per track, or { published: false }", access: "anyone" },

  // Community vote
  { method: "GET", path: "/api/events/{event}/voting", tag: "Community vote", summary: "Voting settings, turnout, suspected duplicates and the count, live while the window is open", access: "organizer" },
  { method: "PUT", path: "/api/events/{event}/voting", tag: "Community vote", summary: "Set the voting window, the ways in, the votes per voter and whether open-link ballots add to the result", access: "organizer", body: In.SettingsInput, also: [409], note: "Once the window has closed the count is final: 409 voting_closed. Whether open-link ballots add to the result (countLink; left out, it stays as it is) is fixed from the first ballot on: 409 count_rule_fixed." },
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
  { method: "PUT", path: "/api/events/{event}/ballot", tag: "Community vote", summary: "Replace your picks while the window is open", access: "voter", body: In.BallotInput, also: [429] },
  { method: "GET", path: "/api/events/{event}/community", tag: "Community vote", summary: "The community count: null for everyone here until the window closes (organizers see it live on /voting)", access: "anyone" },

  // Comments
  { method: "GET", path: "/api/projects/{project}/comments", tag: "Comments", summary: "A project's comments; hidden ones keep their place and reason", access: "anyone" },
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
    note: "A URL that resolves to a private or local address (this machine, the local network) is refused with 422, so a webhook never reaches the portal's own network; the address is checked again before every delivery. WEBHOOKS_ALLOW_PRIVATE=true lets an operator send to a receiver on their own network.",
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
  { method: "GET", path: "/api/events/{event}/outbox", tag: "Email", summary: "The last 100 messages the portal mailed for the event, or would have mailed while email is off", access: "organizer" },

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
  },
  { method: "POST", path: "/api/events/{event}/records/all", tag: "Records", summary: "Issue every record not issued yet", access: "organizer" },
  { method: "GET", path: "/api/records/{record}", tag: "Records", summary: "One signed record and the portal's check of it", access: "anyone" },
  { method: "POST", path: "/api/records/verify", tag: "Records", summary: "Check any signed record against the published keys", access: "anyone", body: envelope },
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
  422: "The body failed validation; details lists the fields (a body of the wrong shape as a whole under request)",
  429: "Too many requests; wait the Retry-After seconds",
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
    if (op.access !== "anyone") refusals.add(401).add(403);
    if (params.length) refusals.add(404);
    if (op.body) refusals.add(422);
    const ok = op.ok ?? 200;
    paths[op.path] ??= {};
    paths[op.path]![op.method.toLowerCase()] = {
      operationId: operationId(op),
      tags: [op.tag],
      summary: op.summary,
      description: `Who may call it: ${WHO[op.access]}${op.note ? ` ${op.note}` : ""}`,
      ...(params.length ? { parameters: params.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })) } : {}),
      ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: schemaOf(op.body) } } } } : {}),
      ...(op.upload
        ? { requestBody: { required: true, content: Object.fromEntries(op.upload.map((type) => [type, { schema: { type: "string", contentMediaType: type } }])) } }
        : {}),
      responses: {
        [ok]: { description: ok === 201 ? "Created" : "OK" },
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
        "Every action in the portal's interface, as JSON. Authenticate with the session cookie, or with Authorization: Bearer <token>: an API token (made at /account/tokens or POST /api/tokens) or a session token. " +
        "Refusals are real 401 and 403 answers with a JSON error code, never redirects.",
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
