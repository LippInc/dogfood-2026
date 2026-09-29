# Architecture

This page is for someone who will read or change the code: what runs, the path every request takes, what happens at
boot and where things live.

One Node container runs the whole portal (`Dockerfile`, `docker-compose.yml`):

- a Next.js App Router server (`node server.js`, standalone build);
- SQLite (better-sqlite3 + Drizzle ORM) in a file on the `/data` volume;
- uploaded project pictures beside it in `/data/uploads`.

The build downloads npm packages once; the running container needs no network. No other process, queue or database
exists.

Three choices are load-bearing:

1. Every permission decision goes through one data access layer, and inside it through one function, `authorize(actor, action, resource)` in `src/server/authz.ts`. App code never imports the database.
2. `docker compose up` alone produces a seeded, working, offline portal: migrations, the fixture import and the deterministic checker sessions all run inside the server's own start-up.
3. Scores are compared only after normalization for judge leniency, and every published number can show how it was made. The method, its receipts and its validation live in `JUDGING.md`; this document does not repeat them.

## A request's path

Every entry point — a page, a route handler under `src/app/api`, a server action — follows the same path:

1. It resolves the actor with `currentActor()` (`src/server/session.ts`): the `session` cookie, or an `Authorization: Bearer` token, which may be a login session token or a named API token (`dfk_` prefix). Unknown, expired or revoked means `null`.
2. It calls a data access function from `src/server/dal/` (the barrel `src/server/dal/index.ts` is the only server import app code may use).
3. A write goes through `mutate()` (`src/server/mutate.ts`), which opens one synchronous better-sqlite3 transaction: `load(tx)` reads the facts the decision needs, `authorize()` decides from them, and only then `run(tx)` makes the change.
4. In the same transaction, `appendAudit()` (`src/server/audit.ts`) writes the audit row and queues webhook deliveries for it; a change made of several things (a pasted list of judge invitations) writes one row for each.
5. The transaction commits: change, audit row and outbox rows together, or nothing.
6. A refusal is a real response, never a redirect.
   - Route handlers catch `AuthzError` (an `HttpError`, `src/server/errors.ts`) and `route()` (`src/server/http.ts`) turns it into 401/403 JSON.
   - Pages call `guardPage()` (`src/lib/page-guard.ts`), which maps the same errors to Next's `unauthorized()` / `forbidden()` / `notFound()` status pages (`src/app/unauthorized.tsx`, `src/app/forbidden.tsx`).
   - A 403 refusal with an identified actor is itself recorded in the audit log (`refusalAudit`, action `authz.refused`).

Gated reads go through `guardRead()` (`src/server/mutate.ts`): they decide the same way, record 403 refusals, and leave no audit row when they pass.

Judge-scoped reads decide on the judge id the request names and refuse it when it is not the session's judge (`scores.read_judge`); they never fall back to the caller's own rows.

**Kept engine runs.** The two judging engines are pure: the same rows give the same run. So `computeNormalization()` and `computePairwise()` keep each run until the data changes (`src/server/dal/memo.ts`):

- The key is the event and the options.
- The version is SQLite's own count of rows this connection has changed (`total_changes()`, triggers included) together with `data_version` (a commit by another connection).
- Inside a transaction nothing is kept or reused, since a transaction can write and roll back.
- Each view runs each engine once and hands the run to its decisions, and the list of an organizer's events reads only where each event stands (`getEventCards`).

On a generated event of 1,000 projects and 150 judges, the organizer's Results view took 14.6 s on every visit before this; now the first visit after a change takes what the engines take and a repeat visit about 40 ms. `tests/results-scale.test.ts` checks that a kept run equals a fresh one, that a write is seen at once, and that a rolled-back run is not kept.

## The boundary

The rule: nothing outside `src/server/` touches the database.

- `tests/dal-boundary.test.ts` reads every `.ts`/`.tsx` under `src/` and fails when a file outside `src/server` imports `drizzle-orm`, `better-sqlite3`, or any server module other than `@/server/dal` and `@/server/boot` — relative paths that resolve into `src/server` are caught too.
- The one sanctioned bridge is `src/instrumentation.ts`, which starts the boot.
- Every file under `src/server/` must open with `import "server-only"`, so a client bundle that reaches one fails to build; `src/server/db/schema.ts` is the single exception (`drizzle.config.ts` reads it to generate migrations).
- The test carries known-bad cases: planted violations that it requires the checker to flag.

## The audit log

This section covers how audit rows are written, why nobody can edit them, how the chain is hashed, and how webhooks ride on the log.

- `appendAudit()` writes one row per change in the same transaction as the change, and one row per 403 refusal; past 60 refusals of one person in 10 minutes, `mutate()` and `guardRead()` answer 429 instead and write nothing (`LIMITS.refusal`).
- Append-only is enforced by the database: triggers reject UPDATE and DELETE, and once an event's results are published also an INSERT into what its ranking rests on (`src/server/db/triggers.ts`). The migrations make them (`drizzle/0012_triggers.sql`, `0017_published_inserts.sql`), and every boot re-asserts them, dropping and restoring one whose SQL was replaced.
- Each row stores the hash of the row before it; its own hash is `sha256(prevHash + "\n" + canonicalJson(row))` over its fields (`chainHash`, `src/server/audit.ts`). `verifyAuditChain()` recomputes the chain and names the row where it breaks.
  - A row of an action whose values a webhook leaves out (ballots, scores and texts, pairwise answers, imports) is hashed with a salt of 32 random bytes from its own column, so its hash cannot be tested against guessed values.
  - The salt never goes into a webhook body and reaches `audit.csv` only with the values (a ballot's once voting closes).
  - Other rows have none and hash as before (`DATA-MODEL.md`, the chain).
- An organizer reads the log on the audit page (`src/app/organize/[event]/audit/page.tsx`, through `getAuditLog`) and exports it as `audit.csv` with the other exports (`src/server/dal/exports.ts`, `GET /api/events/{event}/export/{file}`).
- Webhooks ride on it: `appendAudit()` calls `enqueueForAudit()` (`src/server/webhooks.ts`), which inserts one `webhook_deliveries` row per subscribed webhook. The outbox commits exactly when the change does — none lost, none invented.
  - The worker claims each delivery before sending it (its next attempt moves a minute ahead, only if no other pass moved it first), so two portal processes on one database do not both send it.
  - A pass that dies mid-send leaves it to go out after that minute.

## Boot

Boot turns an empty or existing `/data` volume into a portal ready to serve, in a fixed order.

Next calls `register()` in `src/instrumentation.ts` once per server start (skipped during `next build`, so the build never opens `/data`). `boot()` in `src/server/boot.ts` then runs — all synchronous better-sqlite3 work:

0. **One process per volume.** `claimDataFolder()` (`src/server/instance-lock.ts`) takes `portal.lock` next to the database and refreshes it every 5 s.
   - A second process that finds a fresh lock of another host or live process refuses to start and names it.
   - A lock older than 20 s, or left by this same container before a restart, is taken over; a clean exit removes it.
1. **Migrations.** `runMigrations()` (`src/server/db/migrate.ts`) runs the pending Drizzle migrations from `drizzle/`.
   - Foreign-key enforcement is off while they run (SQLite's recipe for rebuilding a table to add a constraint, as `0016_constraints` does).
   - `PRAGMA foreign_key_check` runs after them and stops the boot on a dangling reference.
   - Before `0016_constraints` runs, rows its two new foreign keys would leave dangling are looked for first, so the boot stops with the database unchanged.
   - Then `assertTriggers()` re-asserts the triggers: the audit log's, the score range, and those that make published results final.
   - Published results are final in these ways: normalization runs and their scores never change; once an event is published, nothing can be added to, edited in or removed from what its ranking rests on (scores and their values, feedback, assignments, the rubric's criteria and weights, judge overrides, pairwise answers and stored runs, and a project's track or merge); an INSERT OR REPLACE is refused like an edit; its publication cannot be withdrawn or pointed at another run.
2. **The fixture import** from `fixtures.json`, once per file.
   - **Already imported:** a boot whose file's SHA-256 is already in `fixture_imports` skips it, so what the organizers changed or removed stands.
   - **Changed:** a changed file imports its new rows, insert-or-ignore.
   - **Refused, for an event that is here:** a changed file that the event here refuses, as an upload would be refused (a team past its size, a second project for a team, a judge on the team they review, a new criterion after scoring, a rubric past its limits, ids two other events hold), or one that adds to an event whose results are published, imports nothing and never stops the start. The log names the file, the row and the rule, and the portal starts with the data it has.
   - **Past the format's limits:** the same holds for a changed file past the fixture format's limits (the Rubric and Questions tabs' limits among them) when an event is here. A file already imported is recognised by its SHA-256 before the format is checked, so a newer portal's tighter limits never stop the start of a volume an older one filled.
   - **Missing or not JSON:** a file missing or not JSON still stops the start with the setting and the path.
   - **Refused, for an event not here yet** (ids two other events hold, a criterion a score's key names past the Rubric tab's limits, a row past the format's limits): it goes by what the volume holds.
     - With other events here, it is logged the same way and the portal starts with those. With `SEED_CHECKER_SESSIONS=true` the log also says no checker sessions are made this start, since they need the fixture event (sessions an earlier start made are left as they were).
     - On a volume with no event at all (a fresh one), the start stops, naming the file, the row and the rule, and says to fix the file or point `FIXTURES_PATH` at another: there is nothing to serve. With `SEED_CHECKER_SESSIONS=true` going on would also stop a step later, on the demo sessions' need for the fixture event; with it off the portal would start empty, which is not what the operator asked for.
   - **What a stop looks like:** a stop exits the process with code 1. Under the shipped `docker-compose.yml` (`restart: unless-stopped`) Docker starts the container again after a pause that grows with each try, so the same line repeats in the log until the file is fixed or `FIXTURES_PATH` changed. The portal answers nothing meanwhile (`docs/OPERATIONS.md`, below its settings table).
   - **None:** `FIXTURES_PATH=none` skips it, for a portal that starts empty (the health check then counts the portal ready without an event).
   - **Orphan pictures:** then `sweepOrphanUploads()` (`src/server/uploads.ts`) deletes stored pictures no project names and logs the count. A picture's file is written before its row commits and deleted after, so a crash in between, or a database restored without its pictures, leaves such files. A database without a single project is left alone.
3. **The signing key.** `ensureSigningKey()` (`src/server/signing.ts`): the Ed25519 key that signs records is made at first boot, kept in the database, and its creation is audited.
4. **Checker sessions,** only when `SEED_CHECKER_SESSIONS=true` (set in `docker-compose.yml`).
   - The four demo identities are upserted, their tokens derived from `DOGFOOD_SEED_SECRET`, the `Cookie: session=...` headers are printed, and the `[auth]`/`[routes]` blocks for `.dogfood.toml` are written next to the database.
   - The two judges are checked again at every start, only among people who still hold the judge role with a track: judge_a is the busiest such judge who shares a track with another, judge_b the busiest sharing one with judge_a (on the fixture always the same two).
   - An identity chosen at an earlier start is kept while it still fits, so the committed `.dogfood.toml` stays true when the organizers move other judges.
   - If the organizers removed judges or changed tracks so that no one fits a label, boot prints one warning, removes that label's old session and starts anyway.
   - With the flag off, boot says so and removes any left from an earlier boot, with the demo sign-ins, the demo organizer's administrator rights, and the API tokens, webhooks, unused account and password reset links and open judge invites made as a demo identity.
5. **The administrator setup link.** While `ADMIN_EMAILS` names an address that has no account yet, boot prints a one-time setup link; only a sign-up through it makes that address an administrator (`src/server/admins.ts`: the code is kept in the process as a hash, works once, and changes at every start).
6. **Background timers:** `startWebhookWorker()` and `startRetentionSweeper()` ([Background work](#background-work), below).
7. **The warm-up** (`src/server/warmup.ts`), then the `portal ready: <url>` line.
   - Once `register()` has returned, the portal asks itself, anonymously, for the fixture event's gallery and the routes the acceptance checker asks first (the refused submit, the judge's scores, the CSV export: each answers 401 before it reads anything, so no audit row is written and no limit is spent), so the first real request to each is warm.
   - `/api/health` answers 503 until it is done. A step that fails is named in a warning and the line still comes.
   - Next opens its port before boot finishes, so that line, not Next's own, is the one to wait for.
   - `bootOrExit()` exits on failure, so `docker compose up` shows the crash instead of serving 500s from a half-seeded database.

The database handle opens lazily on the first query (`handle()`, `src/server/db/client.ts`), with WAL, foreign keys on and a 5 s busy timeout.

## The API

One registry, `OPERATIONS` in `src/server/openapi.ts`, lists every JSON route with its access level and body schema, and three tests keep it true.

- **Bodies:** the request bodies are the DAL's own validators (`src/server/dal/inputs.ts`), except the password and demo sign-ins and the record check, whose bodies the registry states itself, so a documented body cannot drift from what the server checks.
- **Statuses:** each entry names the statuses its route answers. 401, 403 and 429 follow from its access level, 404 from a path part, 422 from a body the DAL validates, and the entry adds the rest (`also`, `answers`) or takes an implied one away (`never`).
- **Served as:** OpenAPI 3.1 at `/api/openapi.json` and the readable reference at `/api-docs`.
- **Authentication** is the same as the interface's: session cookie, `Bearer` session token, or API token. An API token acts as its owner, with the owner's permissions, and cannot make or revoke tokens (`account.tokens` in `src/server/authz.ts`).

The three tests:

1. `tests/api-statuses.test.ts` reads every handler's code with the TypeScript compiler, following each call into `src/` down to the errors thrown and the refusals `authorize()` builds, and adds the proxy's cross-origin 403. It fails when a route can answer a status its entry leaves out or an entry lists one no code path gives, naming the file and line. The few statuses it finds on paths that cannot happen are listed in the test with the reason.
2. `tests/api-registry.test.ts` walks the route files under `src/app/api` and fails when a handler (its method and path) has no entry or an entry has no handler.
3. `tests/api-first.test.ts` fails when a server action behind a form or button (any `"use server"` file under `src/app`) uses a data-layer function that no API route calls, so every action in the interface has its route. On the action side it follows an aliased import and a function handed to a wrapper; on the route side only a call counts (read from the syntax tree, so a type or a comment does not). It refuses a namespace import of the data layer, and it carries a planted case of each shape it must catch.

## Background work

Two timers run inside the server process, both started at boot (`src/server/boot.ts`).

**The webhook worker.** `startWebhookWorker()` runs a timer inside the server process (`src/server/webhooks.ts`), wakes every 2 seconds and sends up to 20 due deliveries, earliest due first.

- A failed delivery retries with backoff (10 s to 2 h, at most six attempts).
- Each one is signed `Dogfood-Signature: t=…,v1=<HMAC-SHA256>`.
- Each one is checked again against private-network targets at send time: the connection's own name lookup refuses a private or local address (IPv6 forms that carry an IPv4 address are judged by that address), so a DNS answer that changes between the check and the connection cannot reach one.
- A delivery reads at most 2 KB of the receiver's answer (the log keeps 500 characters), asks for no compressed answer and follows no redirect.

**Rate limits** (`src/server/rate-limit.ts`) are token buckets in the database (`rate_buckets`):

- ballot saves per voter, new open-link voters per network address, unknown voting codes per network address, comments per account, sign-in attempts per email address from one network address and per email address overall, sign-ups and sign-ins together per network address, and refused requests per person;
- a restart keeps them, and every process on the same database file shares them; buckets idle longer than the slowest refill are deleted;
- a bucket's key is never stored as given: the row holds an HMAC-SHA256 of the whole key under `DOGFOOD_SEED_SECRET`, so the table holds no email or network address.

**The retention sweep.** `startRetentionSweeper()` (`src/server/retention.ts`) runs at boot and then every hour, and deletes password sign-in sessions past their end and rate-limit buckets idle past their slowest refill, so a quiet portal forgets them too. Everything else the portal keeps about people, and what removes it, is the list on `/privacy` and in DATA-MODEL.md ("What is kept, and for how long"); the rest of the removing is the operator's `scripts/purge.mjs`.

## The client's address

The rate limits and the duplicate-ballot flags key on the requester's network address, read from `X-Forwarded-For`, so the container rewrites that header itself.

Next.js fills that header from the connection only when a request arrives without one, so a client talking to the portal directly could name any address it liked.

The container starts the server as `node --import ./scripts/client-address.mjs server.js` (`Dockerfile`). The script wraps `http.Server.prototype.emit` and rewrites the header on every request before Next.js reads it:

- to the connection's own address,
- or with `TRUST_PROXY_HOPS=n` to the address the outermost of n reverse proxies saw,
- and it drops `X-Real-IP`.

It patches Node's server because nothing in Next.js runs with the connection in hand before that header is read: `src/proxy.ts` sees the headers, not the socket. `tests/client-address.test.ts` covers the chain rules and the rewrite on a real server.

## Headers, public, organizer-only

This section lists the response headers the portal sets, what is open without a session, and what only organizers reach.

**On everything,** `next.config.ts` sets:

- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`;
- a `Permissions-Policy` that turns off camera, microphone, location, payment and USB;
- a `Content-Security-Policy` of `base-uri 'self'; form-action 'self'; object-src 'none'`;
- `X-Frame-Options: DENY` and `frame-ancestors 'none'` on every page except `/embed/*` — the embeddable gallery, which answers `frame-ancestors * file:` (any site, and a page opened from disk).

The policy leaves scripts, styles and pictures alone: Next's pages run inline bootstrap scripts, and a project's picture can come from any https host its team names.

**In `src/proxy.ts`:**

- It adds `Strict-Transport-Security: max-age=31536000` to every page and API answer when `PUBLIC_URL` starts with `https://`, read at request time; the offline run on http gets none.
- On `/api/*` it also does this:
  - a write that the browser marks as sent by a page of another origin loses its cookies there, so it reaches the route signed out;
  - a cross-origin sign-in, sign-up, password set with a personal or reset link, or vote entry, which would set a cookie, is refused with 403 (`THREAT-MODEL.md`, "Requests forged by another page").

**Body sizes.** The proxy holds up to 10 MB of a body, so the one route that takes more, `POST /api/imports` (event files up to 64 MB), is left out of its matcher and does both parts that apply to it itself:

- it reads a cross-origin write with its cookies ignored and sets Strict-Transport-Security;
- it reads its body as a stream, only after the caller is found to be an administrator, and stops past 64 MB.

Server actions keep their 5 MB limit (`next.config.ts`).

**Open without a session:** the gallery and project pages, results once published, signed records, the public key document at `/.well-known/dogfood-keys.json`, `/verify`, and the embed.

**Everything else** is decided by `authorize()`; the organizer-only surface (overview, judges, voting admin, audit, exports, webhooks) checks the organizer role for that event. Until a voting window closes, the public community count is `null`; the event's organizers see the running count on the Voting tab and through the API.

The README's "Beyond the checker" table says what exists and who reaches it; `THREAT-MODEL.md` carries the threat model. Neither is repeated here.

## Where things live

- `src/app/` — pages, server actions and route handlers; the JSON API under `src/app/api`.
- `src/components/` — UI: page shells, forms, figures, and shadcn-style primitives under `ui/`.
- `src/lib/` — helpers for app code, client utilities, and `page-guard.ts` (server side).
- `src/fonts/` — self-hosted woff2 fonts, each with its OFL licence file.
- `src/server/` — everything private:
  - the data access layer (`dal/`);
  - the database (`db/`: schema, client, migration runner, triggers, fixture import);
  - the judging engines (`judging/`: normalization, assignment, and `pairwise.ts`, the Bradley-Terry fit and the binary insertion a judge's list is replayed with);
  - the cross-cutting modules: `authz.ts`, `mutate.ts`, `audit.ts`, `session.ts`, `openapi.ts`, `webhooks.ts`, `signing.ts`, `rate-limit.ts`, `http.ts`, `errors.ts`, `boot.ts`, `checker.ts`.
- `src/instrumentation.ts` — the Next hook that starts the boot.
- `drizzle/` — the SQL migrations.
- `scripts/` — for operators, in the image too:
  - `backup.mjs` and `restore.mjs` (`docs/OPERATIONS.md`, "Backup and restore");
  - `purge.mjs`, which removes what is kept about people once it has done its job (the mail log and finished webhook deliveries after 90 days, voters' address and browser hashes once a vote has closed; `docs/OPERATIONS.md`, "Personal data");
  - `verify-record.mjs`, which checks a signed record offline;
  - `webhook-receiver.mjs`, which prints webhook deliveries and checks their signatures.
- `tests/` — vitest suites, including the boundary and API registry tests; the hand check for the tiers run.py does not verify is `tests/isolation_check.py`, and `tests/webhook_live_check.py` checks a signed webhook as it arrives at a receiver.

## Where to change what

- Add a permission rule: an entry in the `Action` and `Resource` unions and a case in `authorize()` (`src/server/authz.ts`), called from a `mutate()`/`guardRead()` DAL function.
- Add a JSON route: the handler under `src/app/api/` plus its `OPERATIONS` entry in `src/server/openapi.ts` — the registry test fails until the two agree, and the status test until the entry names every status the handler can answer; new body shapes go in `src/server/dal/inputs.ts`.
- Add a mutation: a DAL function that calls `mutate()` (`src/server/mutate.ts`) with `load` and `run`; the audit row and webhook queueing follow on their own.
- Add a table: define it in `src/server/db/schema.ts`, generate the migration into `drizzle/`, and touch it only from a module under `src/server/dal/`.
- Change or add a trigger: edit `TRIGGERS` in `src/server/db/triggers.ts` and add a migration (`npm run db:generate -- --custom`) that drops and recreates it; `tests/triggers-migration.test.ts` fails until the migrations match the file.
- Make an action webhook-able: nothing extra. Every audited row that carries an event id can be subscribed to by action name or `*` on the organizer's Integrations tab; platform-wide rows queue nothing. When a new action takes over part of an old one's job, add it to `ALSO_SUBSCRIBED_AS` in `src/server/webhooks.ts` so the old action's subscribers keep getting it (`voting.rules_changed` goes to `voting.settings` subscribers).
- Add an export file: `EXPORT_FILES` in `src/server/dal/exports.ts`.
- Add a rate limit: a key and a `Limit` in `LIMITS` (`src/server/rate-limit.ts`).
- Change sessions, cookies, API tokens or passwords: `src/server/session.ts`.
- Add a boot step: `boot()` in `src/server/boot.ts`.
