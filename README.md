# Dogfood portal

A self-hostable hackathon submission and judging portal, built for Dogfood 2026.
Every score, average and rank it shows can show how it was made.

## Run it

```bash
docker compose up
```

Wait for the line `portal ready: http://localhost:8080/events/sample-hack-2026`
(Next.js prints its own "Ready" a moment earlier, before the database is seeded).
The first start imports `fixtures.json` and prints four `Cookie: session=...`
headers for the acceptance checker; they are the same on every start.
`docker compose down -v` resets everything.

No network is needed at run time. The image build downloads npm packages once.

To look around, open `/sign-in`: while `SEED_CHECKER_SESSIONS=true` it offers
one-click demo sign-ins as the organizer (Demo Organizer), two judges (Diego
Herrera, Jonas Vogel) and a participant.

## Check it

```bash
python run.py .dogfood.toml
```

The organizers' suite covers T1 and T2 only; asked on Discord (#ask-everything,
2026-09-25), the organizers said "T3 and T4 are judged by hand", so run.py prints
"claimed but not verified" for T3 and T4 by design. Our hand check for role
isolation and every T3 and T4 bullet is `tests/isolation_check.py` (Section C, for
T4, is `tests/isolation_t4.py`; standard library only, plus Node for the offline
record check when it is installed). It writes votes and comments and publishes the
sample event's results, so run it on a fresh instance after run.py:

```bash
python tests/isolation_check.py .dogfood.toml
```

Its output from a clean `docker compose down -v && docker compose up` is committed
as `isolation-report.txt`. Our own tests (`npm test`, vitest) cover the permission
rules, the assignment engine, the normalization engine and its Monte Carlo
validation, voting and comments, the audit log's append-only triggers and hash
chain.

## Beyond the checker

Every T3 and T4 bullet from the event site, what exists, and how to check it by
hand. Paths assume the seeded event, `sample-hack-2026` (id `evt_01`).

| Tier | Bullet | Status | Where | Hand check |
|---|---|---|---|---|
| T3 | Community voting: email gated, link based or authenticated | Built | Organizer: Voting tab. Voters: `/events/sample-hack-2026/vote`, `/vote/<code>` | `isolation_check.py` B1, B3, B4, B6. Email gated means a voter list by address with one personal link each; the portal sends no mail, the organizer sends the links |
| T3 | Project comments | Built | Each project page; `GET/POST /api/projects/<id>/comments` | B8: post, organizer hides with a reason, the reason stays in place |
| T3 | Results hidden during the voting window | Built | `GET /api/events/evt_01/community` | B2: the count is `null` for everyone, organizers included, until the window closes; B10 after |
| T3 | Randomized project ordering on ballots | Built | Each voter's ballot, seeded per voter | B4: two ballots, two different orders |
| T3 | Anti abuse: rate limits, duplicate detection, audit trail | Built | Limits on ballots, link entries, comments, sign-in; flags on the organizer's Voting tab; the audit log | B5, B7, B9 (429 with `Retry-After`), B12 (every step is in the audit log) |
| T4 | REST API and webhooks | Built | A JSON route for every action in the interface, through the same data access layer and permission checks; OpenAPI 3.1 at `/api/openapi.json`, readable at `/api-docs`; the session cookie, or a named API token (made at `/account/tokens`, revocable, acting with its owner's permissions) as `Authorization: Bearer <token>`. Webhooks on the organizer's Integrations tab: any audited action, queued in the same transaction as the change, signed `Dogfood-Signature: t=…,v1=<HMAC-SHA256>`, retried with backoff, with a delivery log | `isolation_check.py` C1 to C3. By hand: `curl -H "Authorization: Bearer <organizer token from .dogfood.toml>" localhost:8080/api/events/sample-hack-2026/overview` (200), as the participant (403), with no header (401). To watch a webhook arrive, run a receiver on your machine, set `WEBHOOKS_ALLOW_PRIVATE: "true"` in docker-compose.yml (local targets are refused otherwise), add a webhook on Integrations, press "Send a test" and check the signature with the shown secret |
| T4 | Certificate and record generation | Built | After publishing: a certificate for each member of a submitting team (podium places and a community-vote win on it) and a record for each judge, at `/records/<id>`, printable. Organizers issue them all on the Results tab; people can fetch their own from their project page or the judge console | C4 publishes over the API and issues them. By hand: publish the sample event (Overview: make the three decisions, then Publish), then Results tab, "Issue every record", and open one |
| T4 | Signed, publicly verifiable judge participation records | Built | Ed25519 over the record's canonical JSON; the public key at `/.well-known/dogfood-keys.json` (open to any site); checked in the browser with WebCrypto on each record page and on `/verify`, by `POST /api/records/verify`, or offline with `node scripts/verify-record.mjs <record URL or file> [--keys <saved key file>]` | C4 (a changed record is `bad_signature`), C5 (the script: exit 0, then 1 for the changed copy). By hand: download a record, change one letter, paste it into `/verify`: "Not valid" from the browser and the portal |
| T4 | Embeddable gallery widget | Built | `<script src="http://localhost:8080/embed.js" data-event="sample-hack-2026" async></script>`; the frame is `/embed/sample-hack-2026` | C6. By hand: `curl -sI localhost:8080/embed/sample-hack-2026` shows `frame-ancestors *`; every other page answers `frame-ancestors 'none'` |
| T4 | Bulk import and export | Built | Export at every stage: scores, projects, normalized ranking and audit log as CSV, `event.json`, and `fixtures.json` in the organizers' own fixture format. Import: an administrator uploads such a file on Your events (or `POST /api/imports`), through the same idempotent importer the portal boots with; people who come in that way get personal links to set a password (Integrations tab) | C7 (export, then an import that changes nothing), C8 (a new event imported and one person walked in by a personal link). By hand: export `fixtures.json` from the Integrations tab, import it on a fresh portal: the same tables and a byte-identical `normalized.csv` (`tests/import-claims.test.ts` does exactly this) |

## What it does

- **Events and teams.** An administrator creates an event with dates, tracks,
  prizes, custom questions and a weighted rubric. People sign up, form a team,
  share an invite link, draft and edit a project until the deadline; the server
  refuses changes after it. The public gallery shows every submitted project,
  searchable and filterable by track.
- **Judging.** The organizer invites judges by link (no mail server needed) and
  assigns projects with a seeded, stored assignment run; judges score in a
  keyboard-first console with autosave and see only their own scores. The
  organizer's overview shows progress live and lists the decisions that must be
  made before results can go out: a flat judge, a duplicate entry, an
  under-reviewed project. Scores are normalized for judge leniency with a method
  documented and defended in `JUDGING.md`, and each project's normalized
  score comes with its receipt, judge by judge: the change from the raw mean and
  a ± of one standard error. A judge ledger shows each judge's leniency ± error
  and, before any override, what leaving that judge out would move.
- **Results and exports.** Publishing is locked until every decision is made; it
  stores the exact normalization run it publishes. Teams then see their place,
  score and each review's feedback, judges unnamed. CSV exports (scores,
  projects, normalized ranking, audit log) and a full `event.json` are available
  at every stage.
- **Community vote and comments.** The organizer opens a voting window and chooses
  who may vote: signed-in accounts, a voter list with personal links, and/or an
  open link. Each ballot lists the projects in the voter's own shuffled order; the
  count stays hidden from everyone until the window closes. Suspected duplicate
  ballots are flagged for an audited set-aside; ballots, link entries, comments
  and sign-in are rate limited. Signed-in visitors can comment on projects, and an
  organizer can hide a comment with a reason that stays in its place.
- **Signed certificates and judging records.** Once results are published, each
  team member can get a certificate and each judge a record of their judging,
  signed with the portal's Ed25519 key. Anyone holding one can check it: on its
  page (the browser verifies the signature itself), on `/verify`, or offline with
  `scripts/verify-record.mjs`. The key is made at first start and kept in the
  database; back up the data volume to keep it.
- **API and webhooks.** Everything the interface does is also a JSON route,
  documented at `/api-docs` and as OpenAPI 3.1 at `/api/openapi.json`.
  The document is built from the server's own validators, and a test fails if a
  route and the document disagree. Scripts use named API tokens that act with
  their owner's permissions and cannot make more tokens. Webhooks send any audited action to your URL,
  signed with HMAC-SHA256 and retried with backoff; each delivery is written in
  the same transaction as the change, so none is lost or invented.
- **Import and export.** Every stage exports as CSV, and a whole event as
  `event.json` or as `fixtures.json`, the organizers' own fixture format, which
  an administrator can import into another portal to get the same event, scores
  and ranking. Imported people get into their accounts through one-time personal
  links the organizer sends.
- **Audit log.** Every change and every refused request is recorded in the same
  transaction as the change; the database refuses edits and deletes of the log,
  and each row carries the hash of the one before.

## Running it for a real event

Set `SEED_CHECKER_SESSIONS: "false"` in `docker-compose.yml`: the checker's four
session tokens are public in `.dogfood.toml`. They are derived from
`DOGFOOD_SEED_SECRET`, whose default (`dogfood-2026-public-demo-secret`) is
documented on purpose; set your own when the flag is on anywhere public.

## What it does not do yet

- T4 is partly built; see "Beyond the checker" for what is missing.
- Webhook targets on private or local addresses are refused, when added and at
  every delivery (`WEBHOOKS_ALLOW_PRIVATE=true` lifts that for a receiver on the
  same machine), but a host name whose DNS answer changes between the check and
  the request is not caught. Webhook secrets are kept in the database as they
  are, because the portal signs with them.
- No email: invitations, voter links, personal links for imported people and
  reminders are links the organizer copies and sends. Accounts are not
  email-verified.
- Rate limits and duplicate-ballot flags key on the client address from
  `X-Forwarded-For`; run the portal behind a reverse proxy that overwrites it, or
  a client can pick its own. The limits live in memory and reset on restart.
- Results cannot be unpublished from the interface.
- Signed records cannot be revoked, and the signing key cannot be rotated from
  the interface; a record keeps what was true when it was issued.
- No calibrated prize probabilities or rank intervals: normalized ranks compare
  within a track, and close scores should be read as ties.
- `ARCHITECTURE.md` and `DATA-MODEL.md` are still to come.

## Licence

MIT, see `LICENSE`. The fonts in `src/fonts/` are under the SIL Open Font
License 1.1; each licence sits next to its font.
