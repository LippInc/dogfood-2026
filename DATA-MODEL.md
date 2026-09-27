# Data model

SQLite through Drizzle ORM, one file on the Docker volume at `/data`. Migrations in `drizzle/` (0000_init through 0009_rate_buckets) are applied at boot; right after them, the audit-log and score-range triggers are re-asserted from `src/server/db/triggers.ts`. All timestamps are ISO 8601 text in UTC, and several carry a `julianday(...) is not null` CHECK so a malformed date cannot be stored. Ids are text: rows created in the app get a prefixed random string (`usr_`, `prj_`, `evt_`, ...), while rows imported from the organizers' fixture keep the fixture's ids (`evt_01`, `trk_03`, `prj_32`); imported team members, who have no id in the fixture, get `usr_` and a hash of their email, so a second import finds the same row. JSON columns hold settings, lists and documents (event settings, gallery and tag lists, rubric anchors, run parameters, audit snapshots, webhook payloads, signed envelopes); every relation is a real table. Enum-like and range columns carry real CHECK constraints (Drizzle's TypeScript-only enums are not trusted).

## People and sessions

**`users`** — one row per person. `id` text pk; `email` text unique, stored lowercased (CHECK: equals its lowercase and contains `@`); `name` text; `password_hash` text, null for imported people who have no password yet (argon2id hash, never the password); `is_admin` int boolean, default false (true for an address in `ADMIN_EMAILS` that signed up through the one-time setup link, and for the demo organizer; administrators create and import events); `created_at` text.

**`user_roles`** — one role of one person in one event. Roles are rows, not a column, so a judge who is also a team member is one user with two rows. `user_id`, `event_id`, `role` (`organizer` | `judge` | `participant`), `created_at`; pk (`user_id`, `event_id`, `role`).

**`sessions`** — one signed-in browser or checker session. `token_hash` text pk — the SHA-256 of the cookie token; the token itself is never stored; `user_id`; `kind` (`login` | `checker`); `label` (checker sessions only: `organizer`, `judge_a`, `judge_b`, `participant`; CHECK: a label exists exactly when the kind is `checker`, and it is unique); `created_at`; `expires_at`.

## Events

**`events`** — one event. `id`; `slug` unique (CHECK: lowercase letters, digits, hyphens); `name`; `description`; `submissions_open_at` (null: open from the start); `submissions_close_at`; `judging_close_at`; `voting_open_at`; `voting_close_at` (CHECK: voting opens before it closes; publishing the results ends the vote: an open window closes at the publishing moment, one not yet open is cleared); `results_published_at`; `settings` json (skin, `reviewsPerProject`, `maxTeamSize`, `judgingMode` (`scores` | `pairwise`, absent means scores), the published run, the organizer's not-duplicate pairs, the voting configuration); `created_at`. CHECK: submissions open before they close.

**`tracks`** — one track of an event. `id`; `event_id`; `name` (unique per event); `position`. (`id`, `event_id`) is also unique — it is the target of the composite foreign keys that keep a team, project or assignment inside its own event.

**`prizes`** — one prize of an event. `id`; `event_id`; `name`; `description`; `position`.

**`custom_questions`** — one extra question the organizer adds for projects. `id`; `event_id`; `label`; `help`; `type` (`text` | `longtext` | `url`); `required`; `position`.

## Teams and projects

**`teams`** — one team. `id`; `event_id`; `name` (display only, may repeat); `invite_code` unique, the code in `/join/<code>` — rotating it revokes old links; `created_at`.

**`team_members`** — one person's membership. `team_id`, `user_id` (pk); `event_id`; `role` (`captain` | `member`); `joined_at`. A composite foreign key (`team_id`, `event_id`) → `teams` pins the row to its own event, and a unique index on (`event_id`, `user_id`) enforces one team per person per event in the database, not only the app.

**`projects`** — one project. `id`; `event_id`; `team_id`; `track_id` (both composite-pinned to the event); `title` (non-empty); `summary`; `description`; `repo_url`, `video_url`, `live_url`, `thumbnail_url` (web addresses only: the data access layer and the import refuse anything but http and https); `gallery_urls` json array of at most 6 web addresses, checked the same way; `tags` json array of at most 8 tech tags of up to 24 characters, kept as typed but distinct without regard to case; `status` (`draft` | `submitted`; CHECK: a submitted project has a `submitted_at`); `duplicate_of` — set by the organizer's audited duplicate merge, must differ from `id`, and points to a project in the same event; the row itself is never deleted; `created_at`; `updated_at`.

**`custom_answers`** — one answer to one custom question. `project_id`, `question_id` (pk); `value`.

## Judging

**`rubric_criteria`** — one weighted criterion of an event's rubric. `id`; `event_id`; `key` (unique per event); `label`; `prompt`; `weight` real > 0; `scale_min`, `scale_max` (0 ≤ min < max ≤ 100); `anchors` json, anchor text per level; `position`.

**`judge_tracks`** — one judge's claim on one track. `judge_user_id`, `event_id`, `track_id` (pk); the track is composite-pinned to the event.

**`judge_invites`** — an organizer's invitation link for a judge. `id`; `event_id`; `code_hash` unique — only the SHA-256 of the link's code, so the link is shown once; `name`; `email` (optional, lowercased); `track_ids` json array; `created_at`; `created_by`; `accepted_at`; `accepted_by`; `revoked_at` (CHECK: an invite is accepted or revoked, never both).

**`assignment_runs`** — one stored run of the assignment engine, so any assignment can be traced to its parameters. `id`; `event_id`; `mode` (`fixture` | `fresh` | `topup`); `seed` int; `params` json; `created_at`; `created_by`.

**`assignments`** — one project assigned to one judge. `id`; `event_id`; `judge_user_id`; `project_id` (composite-pinned); `run_id`; `batch_no` ≥ 1; `position` (the judge's seeded review order in the batch); `status` (`pending` | `done` | `recused`); `created_at`. Unique on (`judge_user_id`, `project_id`): a judge never gets a project twice.

**`scores`** — one judge's score for one assignment; judge and project come from the assignment and are not stored twice. `id`; `assignment_id` unique (1:1); `submitted_at` — set only when every criterion is scored, a partial review stays null; `updated_at`; `conflicted` boolean — an imported score whose judge is a member of the scored project's team.

**`score_items`** — one criterion's value within a score. `score_id`, `criterion_id` (pk); `value` int. A CHECK cannot see another table, so the value's range (inside its criterion's `scale_min`..`scale_max`) is enforced by two BEFORE INSERT/UPDATE triggers that read `rubric_criteria`.

**`score_comments`** — the review text attached to a score. `score_id` pk; `feedback` (shown to the team after results are published); `private_note` (never shown to the team; organizers read it on the project's receipt on the results page and in `event.json`).

**`judge_overrides`** — the organizer's audited decision to include a flagged judge or exclude an unflagged one. `id`; `event_id`; `judge_user_id`; `mode` (`include` | `exclude`); `reason` (at least 3 characters once trimmed); `created_at`; `created_by`; `revoked_at`; `revoked_by` (either override can be undone).

**`normalization_runs`** — one run of the normalization engine, or of the pairwise fit. `id`; `event_id`; `method` (`bradley-terry-v1` for a pairwise run); `params` json (W, β̂², σ̂², k, the judges left out, the flat-judge flags, the overrides with their reasons, the merges, and each counted judge's n and leniency); `computed_at`; `computed_by`.

**`normalized_scores`** — one project's result within one run. `run_id`, `project_id` (pk); `n`; `raw_mean`; `normalized_mean`; `se`, one standard error of the normalized mean (null in runs stored before it existed); `rank_raw`; `rank_normalized` (reals, null where not computable). In a pairwise run the same columns hold: `n`, how many judges compared the project; `raw_mean`, the plain share of comparisons it won (ties half); `normalized_mean`, its win % against the track's average; `se`, that win %'s standard error; the ranks by each.

**`comparisons`** — one pairwise answer: which of two projects of one track a judge found better. `id`; `event_id`; `judge_user_id`; `track_id` (composite-pinned); `left_project_id`, `right_project_id` (composite-pinned to the event's projects; CHECK: two different projects); `new_project_id`, the project being placed (CHECK: one of the two shown); `outcome` (`left` | `right` | `tie`); `created_at`; `voided_at`, set when the judge takes the answer back (CHECK: ISO timestamps). The data layer only ever sets `voided_at` and never deletes a row, so every answer ever given stays readable (`comparisons.csv`). A partial unique index keeps at most one live answer per judge and pair of sides.

## Community vote and comments

**`voters`** — one voter in one event, of one of the organizer's chosen kinds. `id`; `event_id`; `kind` (`account` | `listed` | `link`); `user_id` (account voters); `email` (listed voters); `token_hash` unique — the personal or open link's token, only as its SHA-256; `order_seed` int, seeds the voter's own shuffled ballot order; `ip_hash`, `agent_hash` — salted SHA-256, only to flag suspected duplicate voters, never to identify; `created_at`; `last_voted_at`; `voided_at`, `voided_by`, `void_reason` (a void needs a reason of at least 3 characters). CHECK: each kind carries the identity it needs (account → user, listed → email + token, link → token). A user or email votes once per event (unique indexes).

**`votes`** — one ballot entry. `voter_id`, `project_id` (pk); `created_at`.

**`comments`** — one signed-in person's comment on a project. `id`; `event_id`; `project_id`; `user_id`; `body` (1 to 2,000 characters once trimmed); `created_at`; `hidden_at`, `hidden_by`, `hidden_reason` — an organizer's hide, whose reason stays in place.

## Signed records and keys

**`signing_keys`** — the portal's Ed25519 signing key, made at first boot. `id`; `public_jwk` json, served at `/.well-known/dogfood-keys.json`; `private_pkcs8` text, sealed: AES-256-GCM under a key derived from `DOGFOOD_SEED_SECRET` and the key's id (`sealed-v1:` and the base64 of nonce, tag and ciphertext), so a copy of the database alone cannot sign; `created_at`. The private half is the one secret the database must keep verbatim: signing happens on demand, and the key is the root of trust for every certificate and record. Back up the database (README, "Running it for a real event") and keep the same `DOGFOOD_SEED_SECRET`, or records can no longer be issued under the same identity: under another secret the key cannot be opened, and the next start makes a new one (audited; records signed before still verify against the old public key, which stays published).

**`signed_records`** — one signed record per person, event and kind (a judge's participation record, or a team member's certificate). `id`; `event_id`; `kind` (`judge` | `participant`); `user_id`; `key_id`; `envelope` json — the record exactly as signed plus the base64url Ed25519 signature over its canonical JSON; `issued_at`. Unique on (`event_id`, `kind`, `user_id`).

## Webhooks

**`webhooks`** — one organizer's subscription: audited actions of one event, POSTed to a URL. `id`; `event_id`; `url` (CHECK: http or https); `secret` — the webhook's own secret, stored so each delivery can be signed `Dogfood-Signature: t=…,v1=<HMAC-SHA256>`; `actions` json (`["*"]` for all); `created_at`; `created_by`; `disabled_at`.

**`webhook_deliveries`** — the outbox and delivery log; a row is written in the same transaction as the change it announces, so none is lost or invented. `id`; `webhook_id`; `audit_id` (the audit row it came from); `action`; `payload` json; `status` (`pending` | `delivered` | `failed`); `attempts` (0–20); `next_attempt_at`; `last_attempt_at`; `response_status`; `response_body`; `error`; `created_at`; `delivered_at`.

## API tokens and account claims

**`api_tokens`** — one person's named Bearer token for scripts; it acts as its owner with the owner's permissions and cannot make or revoke tokens. `id`; `user_id`; `name` (1–60 characters); `token_hash` unique — only the SHA-256, the token is shown once; `hint` (the first characters, to tell tokens apart); `created_at`; `expires_at` (null or after `created_at`); `last_used_at`; `revoked_at`.

**`account_claims`** — a one-time personal link for an imported person to set a password. `token_hash` pk — only its SHA-256, shown once; `user_id`; `event_id`; `created_by`; `created_at`; `expires_at` (after `created_at`); `used_at`. One unused claim per person: a new link replaces the old one.

## Audit log

**`audit_log`** — one row per change and per refused request, written in the same synchronous transaction as the change it records. `id` integer autoincrement; `at`; `actor_user_id` (null: the system — boot, import); `actor_label`; `action`; `event_id`; `target_type`; `target_id`; `before`, `after` json snapshots; `prev_hash`; `hash`.

Append-only by construction: two triggers reject every UPDATE and DELETE with `RAISE(ABORT)`. They are re-asserted at every boot, and a trigger whose SQL was replaced (a no-op) is dropped and restored.

The chain: each row's `hash` is `sha256(prev_hash + "\n" + canonical JSON of the row's other fields)`, starting from `prev_hash` = 64 zeros. Recomputing the chain from the first row (`verifyAuditChain`) shows any edited, dropped or reordered row: it breaks at that id. What it proves: the log, as stored, is the log that was written, in that order. What it does not: someone holding the database file can rewrite rows and recompute a consistent chain — the triggers only stop edits made through SQLite's SQL layer. Record the chain's head hash elsewhere (it is included in the CSV export) to make tampering detectable. The portal hands such heads out as it goes: every signed record carries, inside its signature, the number and hash of the newest entry when it was signed (its page says whether the log still holds that entry as signed), and the public results page shows the entry that published the results. Whoever holds a record or saved the page holds a copy of that hash, which a rewrite of the log up to that entry would change.

**`fixture_imports`** — one row per import call. `id`; `source`; `sha256` of the imported file; `imported_at`; `counts` json (rows inserted per table).

## Rate limits

**`rate_buckets`** — one token bucket of the rate limits (`src/server/rate-limit.ts`), kept here so a restart keeps it and every process on the same file shares it. `key` pk (the limit and whom it counts, e.g. `signin:<email>:<address>`); `tokens` real (CHECK: never below 0); `at` (milliseconds since 1970, when `tokens` was last worked out); `refused` (the last take was refused, so the next refusal is not audited again). A key with no row has a full bucket; rows idle for longer than the slowest refill (an hour) are deleted as limits are taken.

## Relationships

- Event 1—n tracks, prizes, custom questions, rubric criteria, teams, projects, assignments, votes, comments, signed records, webhooks.
- User n—m event through `user_roles` (one row per role); a person can be organizer, judge and participant at once.
- Team n—m users through `team_members`, one team per person per event; projects belong to one team and one track of the same event (composite foreign keys).
- Assignment run 1—n assignments; assignment 1—1 score; score 1—n score items and 0—1 score comment.
- Judge 1—n comparisons; a comparison names two projects of one track of the same event (composite foreign keys).
- Normalization run 1—n normalized scores; publishing an event stores which run is published in `events.settings`.
- Voter 1—n votes; voter is a user, a listed email, or a link holder.
- Signing key 1—n signed records; webhook 1—n deliveries; delivery references the audit row it came from.

## Where the fixture lands

The import (`src/server/db/import-fixtures.ts`) is idempotent — every insert is INSERT OR IGNORE, so the organizers' later edits survive the next boot — and non-destructive: unknown or conflicting rows are skipped and reported, never thrown away.

| Fixture section | Tables |
|---|---|
| `event` | `events` (slug derived from the name, `submissions_close_at` kept exactly as given) |
| `tracks` | `tracks` |
| (score criteria keys, first-seen order) | `rubric_criteria` (weight 1, scale 1–5, built-in prompts where known) |
| `judges` | `users` (no password), `user_roles` (judge), `judge_tracks` |
| `teams` | `teams` (fresh random `invite_code`) |
| `teams[].members` | `users` (unless the email is already a judge's or has an account — one person, one account), `user_roles` (participant), `team_members` (first member is captain) |
| `projects` | `projects` (status `submitted`, both rows of a duplicate pair kept) |
| `scores` | one `assignment_runs` row (`run_fixture_<event>`, mode `fixture`), then `assignments` (done when complete), `scores` (with `conflicted` where the judge is on the scored team), `score_items` (missing or null keys are not scored, never zeros), `score_comments` |
| (the call itself) | `fixture_imports`, plus one `fixtures.import` audit row when anything was inserted |

Imported rows keep the fixture's ids, with two exceptions listed in the report's `renamed`: a track, team or project id that another event already holds gets `.<event id>` appended, so a second event never links to the first one's rows, and a judge id that is another person's account gets an account of its own (`usr_` and a hash of the email). Assignments and scores get deterministic ids derived from the ids used (`asg_<judge>_<project>`, `scr_<judge>_<project>`). Through the API, a file for an event that already exists adds to it only for that event's organizers, and never once its results are published.

## Privacy

Personal data stored: names and lowercased emails in `users` (and `judge_invites`, and `voters` for listed voters); argon2id password hashes in `users.password_hash`; who commented or voted (user ids); the body of comments. For duplicate-voter detection only, `voters.ip_hash` and `voters.agent_hash` hold SHA-256 hashes of the network address and user agent, salted with `DOGFOOD_SEED_SECRET` and the event id; the raw values are never stored, and the hashes are only compared with each other. The salt is only as private as the secret: with the documented default, someone holding the database could hash every IPv4 address and match them, so a real event sets its own secret (README, "Running it for a real event"). Every link-style credential is stored only as its unsalted SHA-256 (`sessions.token_hash`, `judge_invites.code_hash`, `voters.token_hash`, `api_tokens.token_hash`, `account_claims.token_hash`), so a database dump cannot be used to sign in. Two secrets are stored as-is because the server needs them verbatim: `signing_keys.private_pkcs8` (to sign records at request time) and `webhooks.secret` (to sign each delivery); both exist so the portal can prove things to others, not to identify people. The audit log keeps actor ids and labels, and its `before`/`after` snapshots can contain names or emails — it is readable by organizers only, and exportable as CSV.
