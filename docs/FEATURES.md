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
  text), questions to teams, what teams fill in, team size, prizes, certificate places, judging mode, the tie-break
  criterion, reviews per project, the judges' own-ranking switch, the accent colour and the voting rules, and nothing else: never its dates, people, teams, projects, reviews, votes, comments or invitations, nor
  the history kept with its settings (weight, tie-break and vote rule changes, the published run) or its open voting link.
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
- **Pictures.** A team uploads its project's picture (the gallery card's image) and up to 6 images for the
  project page's gallery, or links images on its own host; the gallery images are shown in the team's order, which
  it changes, like removing one, until the deadline. Once the project is saved, each gallery change saves at once on
  its own; a reorder, removal or added link made on a page that no longer shows the stored gallery is refused with a
  request to reload (an upload is simply added); the
  project form's Save never sends the gallery, so a Save from a page opened before a teammate's upload or removal,
  or an organizer's take-down, leaves the gallery as it is. Each upload is PNG, JPEG or WebP, told by the file's bytes, at
  most 8 MB and 50 megapixels, and is stored redrawn from its pixels as a WebP, so nothing else in the file (a
  photo's location) is published. An organizer takes down a project's picture or any one gallery image at any
  time, with a reason for the audit log. Through the API: `POST /api/projects/{project}/image` and
  `POST /api/projects/{project}/gallery` take the file as the body, `PUT /api/projects/{project}/gallery` sets
  the gallery's order.
- **Gallery.** The public gallery shows every submitted project, searchable and filterable by track and by tag,
  in the page and through `GET /api/events/{event}/projects?q=&track=&tag=`. The search reads each project's
  title, one-line summary, what the team wrote about it, team, track, id and tags, with case and accents ignored
  (`ecole` finds `École`); a project found only through its write-up says which words matched there. The tag
  filter lists the tags the projects carry with how many carry each ("Rust" and "rust" are one tag). The three
  combine, and the filters go into the page's address, so a filtered gallery can be shared as a link. A field
  the organizers hide is not searched.

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
- **Who has not started.** The Judges page lists the judges who have reviews assigned and have saved nothing (no
  score, no word of feedback, no pairwise answer, no conflict declared) right after the flagged ones, and its
  "Not started" view (`?show=not-started`, a link to share) shows only them, with every reminder and their
  addresses to copy at once; `GET /api/events/{event}/judges` marks each judge `notStarted`, and its `started`
  counts the reviews a judge has saved something on or, in pairwise mode, answered about.
- **Emailed reminders.** With `SMTP_URL` set, the Not started view also has "Email reminder" beside each judge's
  copy button and "Email N reminders" for all of them, each mailing the same words the copy button gives (their
  console's address from `PUBLIC_URL`) as one audited action, recorded in the outbox (kind `judge_reminder`). The
  portal mails one judge at most once an hour, counting every reminder that may have reached them (one that failed
  does not count): asked for one judge again sooner, it answers 429 with Retry-After and writes the refusal to the
  audit log; in "Email N reminders" such a judge is left out and named with the minutes to wait. After publishing
  there is nothing to remind anyone of. Without `SMTP_URL` the page keeps its copy buttons only, as before.
  `POST /api/events/{event}/judges/reminders` with `{ judge }` or `{ notStarted: true }` does the same.
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
track with its score and ±, and the audit entry the results were published as, with its hash. A second public page,
`/events/{event}/results/overall`, linked from the first and hidden exactly as long, puts every ranked project in one
order by score across tracks, each beside its track and its place there; places and prizes stay decided within each
track, so the page says to read it loosely. It discloses what the per-track page discloses, with the same notices
and row marks: rubric weights changed after judging began, projects moved to another track after judges were assigned,
and teams changed by the organizers after the close, each with its date and reason, and a place the tie-break decided
("tie broken by <criterion>") with how ties are broken if it was chosen after judging began. In pairwise mode it says instead why there is no overall order: a win % is
measured only against the projects of its own track. Teams then see
their place, their score with its ±, and each review's feedback, judges unnamed. CSV exports (scores, projects,
assignments, normalized ranking, pairwise answers, ballots, comments, prize awards, audit log) and a full
`event.json` are available at every stage (each file's columns: "Import and export").

## Prizes

An event's prizes (a name and a description each, on Settings) are given on the organizer's Results tab, in its
Prizes step, before publishing. Each prize goes to one project, or to several as a joint award, with an optional
note shown beside it; the ranking's places in each track stand beside the projects to choose from. A prize can
also stay unawarded, which is where every prize starts: the Overview's Publish panel says how many are not awarded
yet, and publishing is allowed anyway (they stay unawarded). Every award, change or taking back is one entry in the
audit log ("awarded the prize ... to ..."), and removing an awarded prize on Settings takes its award with it, logged
as taken back (the Prizes section names each award and says so before you save). Once published with a prize
awarded, the Prizes section on Settings is locked like Tracks. Only the event's submitted projects can win. Merging away a project that holds an award is
refused (409 `prize_awarded`: take the award back first, then merge), and the refusal is logged; the kept copy may hold one. Publishing makes the awards final: the app answers 409 `results_published`, and the database
refuses a changed award, and any edit to the prize list of an event that awarded one. Once published, the public
results show each prize with its winners (each with its published place in its track) and note, a winner's project page says "Winner, <prize>", and so does its
team's certificate ("Joint winner, <prize>" for a joint award). `GET /api/events/{event}/awards` lists them
(organizers before publishing, anyone after), `PUT /api/events/{event}/awards/{prize}` sets one, and `awards.csv`
exports them. An event that awards no prize shows, exports and signs exactly what it did before.

## Breaking exact ties

Projects in one track with exactly the same score share a place ("Joint 2nd") unless the organizer chooses, under
Settings, "Exact ties", one rubric criterion to break such ties: the higher plain average on that criterion over the
counted reviews places first, and projects tied on it too stay joint. It applies within a track only, and only to
exactly equal scores; it never reorders anything else. The organizer's Results tab lists each exact tie and how the
criterion ordered it. The public results, the project's page, the embed, the certificates and `normalized.csv` say
"tie broken by" the criterion wherever it decided a place. The choice is audited, needs a reason once judges have
scored (the published results then show the change), and is final once results are published. Pairwise judging has no
criteria, so there the setting is refused (409) and ties stay joint. The exact rule: JUDGING.md, "Breaking exact ties".

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

## Updates

An organizer posts news to the event on its Updates page (`/organize/{event}/updates`, linked from Settings): a title of up to 120
characters and a plain-text body of up to 5,000. The event's Projects and About pages show the newest three with
their times (UTC) and a link to its Updates page (`/events/{event}/updates`), which lists every one; an event
without updates shows nothing, so its pages are as they were. The body is text, never HTML: its line breaks are
kept, a tag shows as its own characters and a web address shows as text, not a link.

- **Audited.** Posting, editing and removing are one audited write each (`update.post`, `update.edit`,
  `update.remove`); an edit and a removal keep the old title and words in their audit row, and an edited update
  says when it was edited.
- **After publishing too.** Updates are news, not results: publishing freezes the results and the event's
  settings, not its updates, so "winners announced" can go out after the results do.
- **Email.** With `SMTP_URL` set, the form has a box, off by default, that says how many people the update goes
  to: every member of a team in the event, once each. Ticked, the update is mailed to them after it is posted,
  each message recorded in the outbox (kind `event_update`, the updates page's link kept) with its result, and
  the page says how many went and which could not. The audit log says an update is to be mailed only when mail
  is tried for at least one person, never on the box alone. Without `SMTP_URL` the box is not there and one line says email
  is off. An edit is never mailed again.
- **API.** `GET /api/events/{event}/updates` (anyone), `POST` to post (`email: true` to mail it), `PUT` and
  `DELETE` on `/api/events/{event}/updates/{update}` (organizers).
- **Export and import.** `fixtures.json` carries them (`updates`, oldest first, with `edited_at` when edited) and
  an import brings them into a new event, recorded as posted by the importer; a file that would add an update to
  an event that is here already is refused whole, as its ballots and comments are.

## Signed certificates and judging records

Once results are published, each member of a submitting team can get a certificate (places 1 to 3 in the track,
or as many as the organizer sets on Settings before publishing, a community-vote win and each prize won on it) and each judge a
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
API adds it only with `?bom=1`), from the organizer's Integrations tab or `GET /api/events/{event}/export/{file}`,
organizers only, each with a header row even while there is nothing to list:

- `scores.csv`: every review, criterion by criterion; `projects.csv`: every project; `normalized.csv`: the
  ranking; `comparisons.csv`: every pairwise answer; `audit.csv`: the log with its hashes.
- `assignments.csv`: every assignment, one row each: judge, project, track, status (pending, done, recused), how
  far the review got, when it was assigned, last saved and submitted, a recusal's time and reason, and the run that
  made it (import, fresh run, top-up, by hand). How far the review got: in scores mode none, draft or submitted,
  last saved at the review's latest save; in pairwise mode, which saves answers rather than reviews, answered once
  the judge has an answer about the project that was not taken back, last saved at the latest such answer (the same
  rule that keeps an organizer from taking the assignment back; an event switched back to scores keeps it).
- `votes.csv`: every ballot, one row per voter: how they voted in, whether the ballot counts (set aside, or an
  open-link ballot counted apart), and the picks. Until the voting window closes the picks read "hidden until
  voting closes", for every ballot, exactly as `audit.csv` seals a ballot.
- `comments.csv`: every comment with its project and author; a comment an organizer hid keeps its row with who
  hid it, when and why, and an empty body: its words are not exported.
- `awards.csv`: every prize, one row per winner (a joint award one row for each of its projects), and an unawarded
  prize as one row with the project columns empty; its status is draft before publishing and final after.

A whole event also exports as `event.json` or as `fixtures.json`, the organizers' own
fixture format with the rest of the event added (rubric, questions and answers, dates, settings, prizes, the
reviews' times and private notes, merges and every organizer decision with its reason, the prizes given, pairwise answers, ballots
once voting has closed, comments, the organizers' updates, and the published results as stored): the file that
moves an event. An administrator imports such a file on Your events (or `POST /api/imports`), through the same idempotent importer the
portal boots with, and gets the same event back as a new event (`tests/event-round-trip.test.ts`: exported again,
the file is the same, and so are its ranking, count and exports); what stays behind is listed in
[`OPERATIONS.md`](OPERATIONS.md#moving-an-event-to-another-portal). Into an event already here an import adds none of
that history (409 `new_event_only`, naming what the file would add). A file for an event already here adds to it only for that
event's organizers and never once its results are published, never changes the criteria of an event judges have
scored (409 `rubric_in_use`), keeps its deadlines as the forms do (no project once submissions have closed, 409
`submissions_closed`; no review once judging has closed, 409 `judging_closed`), keeps the forms' team rules there (409 `team_full`, `team_has_project`,
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
longest (5,000 when each review also carries the longest private note), before its ballots and comments; people who come in that way get one-time personal links to set a password (Integrations tab).

## Help

Every top bar has a Help button (on a phone, the event pages keep it in the Menu, so the event's name keeps its one
line); the `?` key opens it too, outside text boxes (the judge console and the compare
page keep `?` for their own lists of keys, which point at Help, and the panel has a switch that turns the key off
in that browser). It opens a panel beside the page, full screen on a phone: a question box, three to five suggested
questions for the reader's roles, and the answers as a short thread that lasts while the page is open and is stored
nowhere.

- **What it answers from.** The portal's own guide, `src/lib/help/index.ts`: every page a person can reach, the
  tour's tasks and the ideas behind the judging (the leniency correction and its ±, the flat-judge rule, the signal
  check, pairwise mode, the audit chain, the freeze after publishing, ballots, open-link votes, demo mode, backups,
  the API).
- **Each answer** is the best one to three entries: a sentence or two, a link to the page for the event in view,
  who it is for, and for an idea the document and heading to read. Among close matches (within 80 % of the best text score), what the reader can do
  ranks first (for a visitor, what any account can do counts); the rest is labelled whose it is, in plain words:
  "Organizers only", "Judges and organizers only", "Sign in to do this". A weaker match never jumps a much better
  one. When nothing matches well enough it says so and offers the main places; it never guesses.
- **How it matches.** In the browser, with nothing sent: word stems (never merging two different words: "tracking"
  is not "track"), synonyms and the words people type, a slip of one letter forgiven, BM25 over each entry's title,
  keywords and answer, and floors below which the answer is "no match": a match must cover at least 60 % of the
  question's words and enough of its rarer ones, and score high enough; a word counts in full only when the entry's
  title or keywords name it, and for part of a word when it comes through a synonym or only from the answer's text. The reader's roles come with the page, read
  on the server through the data access layer.
- **Its limit.** It finds pages and answers from the portal's own guide; it is not an AI model.

`tests/help.test.ts` holds the guide to the code (each link to a route file, each role to a real one, each
document heading to its file) and the matcher to over 60 questions as people type them, with nonsense and over 20
realistic questions the guide does not cover (a venue, a refund, a mobile app) answered "no match".
`tests/help-corpus.test.ts` asks over 240 questions (when something opens or closes, where to do something, who can
see what) as a visitor, a team member, a judge, an organizer and an administrator, and expects for each reader the
entry that answers it first, or "no match" where the portal has no answer.

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
