# What the portal does, in full

The README gives the short list; this page has the rules behind each item. How judging turns scores into a
ranking is in [`JUDGING.md`](../JUDGING.md), and what the portal stops is in [`THREAT-MODEL.md`](../THREAT-MODEL.md).

## Events and teams

An administrator creates an event with dates, tracks, prizes, custom questions and a weighted rubric. People
sign up, form a team, share an invite link and draft and edit a project until the deadline (name, tagline,
description, repository, demo video and live links, a picture, an image gallery, tech tags, the track and the
organizer's questions); the server refuses changes after it.

- **A second event from the first one's settings.** On New event, "Start from the settings of" lists the events
  the administrator organizes; the new event takes that event's tracks, rubric (labels, prompts, weights, anchor
  text), questions to teams, what teams fill in, team size, prizes, certificate places, judging mode, reviews per
  project, the judges' own-ranking switch, the accent colour and the voting rules, and nothing else: never its dates, people, teams, projects, reviews, votes, comments or invitations, nor
  the history kept with its settings (weight and vote rule changes, the published run) or its open voting link.
  The name and dates come from the form. Starting from an event you do not organize is refused (403), and the
  create and the copy are one audited change whose log line names the source (`sourceEventId` on
  `POST /api/events` does the same).

- **What teams fill in.** The organizer makes each of those fields required, optional or hidden (Settings, "What
  teams fill in"), so an event where everyone builds the same thing can ask for a repository link and nothing
  else. A project with no title of its own is called by its team's name, and so is every project while the title
  is hidden; a hidden track is the event's one track, and a hidden field is shown nowhere (what a team typed
  before stays stored and returns if the field comes back).
- **Solo events.** With one person per team (most people on one team: 1), taking part is one step: no team to
  name (the entry goes by the person's name) and no invite link.
- **Team changes before the deadline.** A member can rename the team or leave, the captain can take a member off
  or hand the captaincy over, and a team's only member can dissolve it, a draft project with it, but never a
  submitted one.
- **Team changes after the deadline.** An organizer renames a team, adds someone to it or takes someone off, each
  with a reason for the audit log, from the team's page under Submissions, until results are published; the
  project page says the organizers changed the team after the close. A change that would move the community
  vote count, because the person voted for that team's project, is refused until the vote is voided.
- **Gallery.** The public gallery shows every submitted project, searchable (tags included, case and accents
  ignored: `ecole` finds `École`) and filterable by track, in the page and through
  `GET /api/events/{event}/projects?q=&track=`.

## Judging

- **Invitations.** The organizer invites judges by link, one at a time or from a pasted list of names and
  addresses, one link each (no mail server needed; a link stops admitting judges once judging closes or the
  results are out). The list takes each line as people paste it: `Name <email>` from an email client's To line
  (a quoted name may hold a comma), `name, email` or a tab between them from a spreadsheet, or an address alone;
  after the address a line may name its own tracks, separated by `;`. A line that cannot be read is named with
  its reason and nothing is made; lines that name no tracks while none are ticked are named together with what
  to tick (an event with one track gives it to them).
  An address holds one open invitation per event: inviting it again replaces the open one.
  The Judges page then says the older link stopped working, the audit log says it was replaced by a new
  invitation, and the old link tells whoever opens it that a newer invitation replaced it.
- **Assignment.** Projects are assigned with a seeded, stored assignment run; judges score in a keyboard-first
  console with autosave and see only their own scores.
- **Decisions before publishing.** The organizer's overview shows progress live and lists the decisions that
  must be made before results can go out: a flat judge, a duplicate entry, an under-reviewed project.
- **Live pages.** The overview and the Judges, Voting and Integrations pages refresh every 15 s while the tab is
  in view, keeping an open decision or a half-typed reason. Their Live switch pauses that for the whole tab, on
  every organizer page, until it is resumed; resuming fetches fresh numbers at once.
- **Normalization and receipts.** Scores are normalized for judge leniency (method and its defence in
  `JUDGING.md`), and each project's normalized score comes with its receipt, judge by judge: the change from the
  raw mean and a ± of one standard error. A judge ledger shows each judge's leniency ± error and, before any
  override, what leaving that judge out would move.
- **Fixing set-up mistakes,** each with a reason in the audit log: from a project's page (Submissions, its review
  count) an organizer takes back an assignment nobody started, undoes a recusal clicked by mistake, or moves the
  project to another track after judges were assigned; on the Judges page, a judge's name opens their removal
  (an invitation taken by the wrong account): what they saved stays on record, out of the ranking, and the
  receipts name them.

## Pairwise judging (optional)

An organizer can have judges answer "which is better?" instead of scoring: the switch is on Settings, audited,
with a reason, and can be switched back until results are published. Judges see two of the projects they were given
at a time, may call it too close, and place each project into their own order in about log₂ n answers, with the arrow
keys. The ranking is a Bradley-Terry fit of every answer, with the pull of the left side and of the project just
opened measured and corrected for; each place carries its chance of really being ahead of the next, each project a
receipt of the comparisons behind it, and scores given before the switch still count as the order they imply.
Judges whose answers look like coin flips are flagged for the organizer to settle before publishing. The method,
its limits and its Monte Carlo proof: `JUDGING.md`, "Pairwise mode".

**Try it on the sample event** (the README tour's optional step, before step 5 publishes): as the organizer,
**Settings**, "How judges judge": choose Pairwise and give a reason. As a judge, the console now asks "which is
better?" about two projects at a time: answer with ← and →, try **T** (too close to call) and **U** (undo). The
organizer's **Results** then shows each project's win % with its ±, the chance it is ahead of the next place, and its
receipt. Switch back to Scores (with a reason) before publishing: the scored ranking comes back unchanged, and the
judge's record will count the answers given.

## Results and exports

Publishing is locked until every decision is made; it stores the exact normalization run it publishes, and the
database refuses to withdraw it or swap it for another run. The public results page shows every project in each
track with its score and ±, and the audit entry the results were published as, with its hash. Teams then see
their place, their score with its ±, and each review's feedback, judges unnamed. CSV exports (scores, projects,
normalized ranking, audit log) and a full `event.json` are available at every stage.

## Community vote

This section is the one place the voting rules are stated.

- **Who may vote.** The organizer opens a voting window and chooses any of: signed-in accounts; a voter list by
  address, with one personal link each (with `SMTP_URL` set the portal mails each link as it is made, otherwise
  the organizer sends them); an open link.
- **The open link is counted apart.** Its ballots show in their own column and add to the result only if the
  organizer chose that before the first ballot; the choice is fixed once ballots are in.
- **Ballots.** Up to three picks; each ballot lists the projects in the voter's own shuffled order; nobody signed
  in can vote for their own team's project; one ballot per person the portal can name.
- **Saving a pick.** Each pick saves at once and the ballot's bar says how it went; a quick second pick goes out
  after the first, never alongside it. A dropped connection keeps the pick on screen, marked not saved, and
  retries (1, 2, 4, 8 s, then every 15 s) until it saves. An answer that is not the portal's (a reverse proxy's
  502 page while the portal restarts) gets the same retries for about 45 s, the bar saying it is still trying. A
  refusal (voting has closed) puts the ballot back to what the portal holds, with the reason; an error from the
  portal, or the 45 s running out, puts it back and says to reload. A link away or a reload with a pick not yet
  saved asks first, and a retry that was waiting goes out as the ballot goes.
- **The count** is live for organizers only while the window is open, public when it closes, and final from then
  on. Publishing the results closes an open vote (and calls off one not yet open), so nobody votes with the
  ranking in view; its count goes public with the results.
- **Abuse.** Suspected duplicate ballots are flagged while voting is open, for an audited set-aside; ballots,
  link entries, comments and sign-in are rate limited (429 with `Retry-After`); every step is in the audit log.
- **Demo mode.** On the demo portal the sample event's vote opens at the first start for 30 days, for signed-in
  accounts and through an open link the start prints (`community vote (demo): ...`); like a new event, the demo
  does not add open-link ballots to the result.

## Comments

Signed-in visitors can comment on projects and delete their own comments; an organizer can hide a comment with a
reason, and unhide it again. While it is hidden, the organizers and its author see its place and the reason, never
its text (its author cannot delete it then); everyone else sees one comment fewer. Comments cannot be
edited: delete and post again.

## Signed certificates and judging records

Once results are published, each member of a submitting team can get a certificate (places 1 to 3 in the track,
or as many as the organizer sets on Settings before publishing, and a community-vote win on it) and each judge a
record of their judging, at `/records/<id>`, printable, signed with the portal's Ed25519 key over the record's
canonical JSON. Organizers issue them all on the Results tab; people can fetch their own from their project page
or the judge console. Anyone holding one can check it: on its page (the browser verifies the signature itself
with WebCrypto), on `/verify`, by `POST /api/records/verify`, or offline with `node scripts/verify-record.mjs
<record URL or file> [--keys <saved key file>]`. The public key is at `/.well-known/dogfood-keys.json`. A record
keeps what it was signed with: if the organizers rename the event later, its page says so beside the signed
name. The key is made at first start and kept in the database, sealed under `DOGFOOD_SEED_SECRET`; back the
database up ([`OPERATIONS.md`](OPERATIONS.md)) and keep the secret to keep it.

## API and webhooks

Everything the interface does is also a JSON route (a test holds every data-layer function a form or button calls
to an API route that calls it too), through the same data access layer and permission checks, documented at
`/api-docs` and as OpenAPI 3.1 at `/api/openapi.json`, with every status each route can answer. Its request bodies
come from the server's own validators; a test fails if a route is missing from it or it lists a method and path no
route answers, and another reads the handlers' code and fails when the document and the code disagree on a status.
Scripts use named API tokens (made at `/account/tokens`, revocable) as `Authorization: Bearer <token>`; a token
acts with its owner's permissions and cannot make more tokens, a password reset link or personal claim links (each would reach a full sign-in). Webhooks (the organizer's Integrations tab) send
any audited action to your URL (ballot picks, scores and pairwise answers left out: who acted and when, never the
values), signed `Dogfood-Signature: t=…,v1=<HMAC-SHA256>` (a receiver refuses a `t` more than five minutes from
its clock) and retried with backoff, with a delivery log; each delivery is written in the same transaction as the
change, so none is lost or invented, and claimed before it is sent, so two portal processes on one database do not
both send it.

## Import and export

Every stage exports as CSV (the download buttons add a UTF-8 byte-order mark so Excel reads accented names; the
API adds it only with `?bom=1`), and a whole event as `event.json` or as `fixtures.json`, the organizers' own
fixture format with the rubric (labels, prompts, weights), the questions to teams and their answers, and each
project's description and links added: the file that moves an event. An administrator imports such a file on Your
events (or `POST /api/imports`), through the same idempotent importer the portal boots with, and gets the same
projects, judges, scores and rubric, and the same ranking as before any decision (settings and the organizer's
decisions stay in `event.json`, the record to keep). A file for an event already here adds to it only for that
event's organizers and never once its results are published, never changes the criteria of an event judges have
scored (409 `rubric_in_use`), keeps the forms' team rules there (409 `team_full`, `team_has_project`,
`conflict_of_interest`, `vote_would_change`, naming the row), holds the criteria and questions it brings to the Rubric and Questions
tabs' limits (at most 16 criteria with labels of 2 to 60 characters and prompts of at most 200; at most 20
questions with labels of 3 to 200 characters and help of at most 300; past one, 422 naming the row), renames an
id another event holds rather than share it (409 `id_taken` when the new name is taken too), never writes into a
review the portal handed out (pending, a draft or finished, it stays the judge's own; the report's `skipped`
names the file's row), and imports an event's own export back unchanged; the import's audit row names each judge,
review and judge's track it added, and `scores.csv` marks each imported review in its `source` column. While the organizer hides the project title, `projects.csv`'s `title` and `scores.csv`'s
`project_title` keep what the team typed, and a last column, `shown_title`, gives the name shown meanwhile (the
team's). Files up
to 64 MB, which holds the portal's own export of 1,000 projects and 8,000 reviews with every field at its
longest; people who come in that way get one-time personal links to set a password (Integrations tab).

## Audit log

Every change, and every request refused to someone signed in or holding a voting link, is recorded in the same
transaction as the change (past 60 refusals in 10 minutes a person gets 429 and no row, so the log cannot be
flooded). Each event's entries are on its Audit log tab; the entries no event owns (accounts, sign-ins, API
tokens, the signing key, demo mode) are on Your events, Portal log, for administrators; both are in the API
(`GET /api/events/{event}/audit`, `GET /api/audit`). The database refuses edits and deletes of the log, and each
row carries the hash of the one before; the organizer's audit page and `audit.csv` show the chain's head. The
rows of ballots, scores, pairwise answers and imports are hashed with a random salt of their own, shown in
`audit.csv` only with their values; how to rebuild any row's hash from its `audit.csv` line:
[`DATA-MODEL.md`, "Audit log"](../DATA-MODEL.md#audit-log).
