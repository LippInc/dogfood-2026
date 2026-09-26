# Architecture

One Node container runs the whole portal: a Next.js App Router server (`node server.js`, standalone build) with SQLite (better-sqlite3 + Drizzle ORM) in a file on the `/data` volume (`Dockerfile`, `docker-compose.yml`). The build downloads npm packages once; the running container needs no network. No other process, queue or database exists. Three choices are load-bearing:

1. Every permission decision goes through one data access layer, and inside it through one function, `authorize(actor, action, resource)` in `src/server/authz.ts`. App code never imports the database.
2. `docker compose up` alone produces a seeded, working, offline portal: migrations, the fixture import and the deterministic checker sessions all run inside the server's own start-up.
3. Scores are compared only after normalization for judge leniency, and every published number can show how it was made. The method, its receipts and its validation live in `JUDGING.md`; this document does not repeat them.

## A request's path

Every entry point — a page, a route handler under `src/app/api`, a server action — follows the same path:

1. It resolves the actor with `currentActor()` (`src/server/session.ts`): the `session` cookie, or an `Authorization: Bearer` token, which may be a login session token or a named API token (`dfk_` prefix). Unknown, expired or revoked means `null`.
2. It calls a data access function from `src/server/dal/` (the barrel `src/server/dal/index.ts` is the only server import app code may use).
3. A write goes through `mutate()` (`src/server/mutate.ts`), which opens one synchronous better-sqlite3 transaction: `load(tx)` reads the facts the decision needs, `authorize()` decides from them, and only then `run(tx)` makes the change.
4. In the same transaction, `appendAudit()` (`src/server/audit.ts`) writes the audit row and queues webhook deliveries for it.
5. The transaction commits: change, audit row and outbox rows together, or nothing.
6. A refusal is a real response, never a redirect. Route handlers catch `AuthzError` (an `HttpError`, `src/server/errors.ts`) and `route()` (`src/server/http.ts`) turns it into 401/403 JSON. Pages call `guardPage()` (`src/lib/page-guard.ts`), which maps the same errors to Next's `unauthorized()` / `forbidden()` / `notFound()` status pages (`src/app/unauthorized.tsx`, `src/app/forbidden.tsx`). A 403 refusal with an identified actor is itself recorded in the audit log (`refusalAudit`, action `authz.refused`).

Gated reads go through `guardRead()` (`src/server/mutate.ts`): they decide the same way, record 403 refusals, and leave no audit row when they pass. Judge-scoped reads decide on the judge id the request names and refuse it when it is not the session's judge (`scores.read_judge`); they never fall back to the caller's own rows.

## The boundary

The rule: nothing outside `src/server/` touches the database. `tests/dal-boundary.test.ts` reads every `.ts`/`.tsx` under `src/` and fails when a file outside `src/server` imports `drizzle-orm`, `better-sqlite3`, or any server module other than `@/server/dal` and `@/server/boot` — relative paths that resolve into `src/server` are caught too. The one sanctioned bridge is `src/instrumentation.ts`, which starts the boot. Every file under `src/server/` must open with `import "server-only"`, so a client bundle that reaches one fails to build; `src/server/db/schema.ts` is the single exception (`drizzle.config.ts` reads it to generate migrations). The test carries known-bad cases: planted violations that it requires the checker to flag.

## The audit log

- `appendAudit()` writes one row per change in the same transaction as the change, and one row per 403 refusal.
- Append-only is enforced by the database: triggers reject UPDATE and DELETE (`src/server/db/triggers.ts`), re-asserted with `CREATE TRIGGER IF NOT EXISTS` at every boot.
- Each row stores the hash of the row before it; its own hash is `sha256(prevHash + "\n" + canonicalJson(row))` over its fields (`chainHash`, `src/server/audit.ts`). `verifyAuditChain()` recomputes the chain and names the row where it breaks.
- An organizer reads the log on the audit page (`src/app/organize/[event]/audit/page.tsx`, through `getAuditLog`) and exports it as `audit.csv` with the other exports (`src/server/dal/exports.ts`, `GET /api/events/{event}/export/{file}`).
- Webhooks ride on it: `appendAudit()` calls `enqueueForAudit()` (`src/server/webhooks.ts`), which inserts one `webhook_deliveries` row per subscribed webhook. The outbox commits exactly when the change does — none lost, none invented.

## Boot

Next calls `register()` in `src/instrumentation.ts` once per server start (skipped during `next build`, so the build never opens `/data`). `boot()` in `src/server/boot.ts` then runs — all synchronous better-sqlite3 work:

1. `runMigrations()` (`src/server/db/migrate.ts`): pending Drizzle migrations from `drizzle/`, then `assertTriggers()` re-asserts the audit-log triggers.
2. The idempotent fixture import from `fixtures.json`: a second boot with the same file changes nothing. `FIXTURES_PATH=none` skips it, for a portal that starts empty (the health check then counts the portal ready without an event). Then the accounts named in `ADMIN_EMAILS` become administrators, each grant audited (`src/server/admins.ts`); sign-up does the same for a new account.
3. `ensureSigningKey()` (`src/server/signing.ts`): the Ed25519 key that signs records is made at first boot, kept in the database, and its creation is audited.
4. Checker sessions, only when `SEED_CHECKER_SESSIONS=true` (set in `docker-compose.yml`): the four demo identities are upserted, their tokens derived from `DOGFOOD_SEED_SECRET`, the `Cookie: session=...` headers are printed, and the `[auth]`/`[routes]` blocks for `.dogfood.toml` are written next to the database. With the flag off, boot says so and removes any left from an earlier boot.
5. `startWebhookWorker()` (below).
6. The `portal ready: <url>` line. Next opens its port before boot finishes, so that line, not Next's own, is the one to wait for; `bootOrExit()` exits on failure, so `docker compose up` shows the crash instead of serving 500s from a half-seeded database.

The database handle opens lazily on the first query (`handle()`, `src/server/db/client.ts`), with WAL, foreign keys on and a 5 s busy timeout.

## The API

One registry, `OPERATIONS` in `src/server/openapi.ts`, lists every JSON route with its access level and body schema; the bodies are the DAL's own validators (`src/server/dal/inputs.ts`), so the document cannot drift from what the server checks. The registry serves OpenAPI 3.1 at `/api/openapi.json` and the readable reference at `/api-docs`. `tests/api-registry.test.ts` walks the route files under `src/app/api` and fails when a handler has no entry or an entry has no handler. Authentication is the same as the interface's: session cookie, `Bearer` session token, or API token. An API token acts as its owner, with the owner's permissions, and cannot make or revoke tokens (`account.tokens` in `src/server/authz.ts`).

## Background work

The only background work is the webhook worker: `startWebhookWorker()` runs a timer inside the server process (`src/server/webhooks.ts`), wakes every 2 seconds and sends up to 20 due deliveries, earliest due first. A failed delivery retries with backoff (10 s to 2 h, at most six attempts); each one is signed `Dogfood-Signature: t=…,v1=<HMAC-SHA256>` and is checked again against private-network targets at send time. Rate limits (`src/server/rate-limit.ts`) are token buckets in one in-memory Map: ballot saves, new link voters, comments, sign-in attempts. A restart forgets them, and a second portal process would keep its own counts — one reason the portal is built to run as a single process.

## Headers, public, organizer-only

`next.config.ts` sets `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` on everything, and `X-Frame-Options: DENY` plus `Content-Security-Policy: frame-ancestors 'none'` on every page except `/embed/*` — the embeddable gallery, which answers `frame-ancestors *`. Open without a session: the gallery and project pages, results once published, signed records, the public key document at `/.well-known/dogfood-keys.json`, `/verify`, and the embed. Everything else is decided by `authorize()`; the organizer-only surface (overview, judges, voting admin, audit, exports, webhooks) checks the organizer role for that event. Until a voting window closes, the community count is `null` for everyone, organizers included. The README's "Beyond the checker" table says what exists and who reaches it; `JUDGING.md` carries the threat model. Neither is repeated here.

## Where things live

- `src/app/` — pages, server actions and route handlers; the JSON API under `src/app/api`.
- `src/components/` — UI: page shells, forms, figures, and shadcn-style primitives under `ui/`.
- `src/lib/` — helpers for app code, client utilities, and `page-guard.ts` (server side).
- `src/fonts/` — self-hosted woff2 fonts, each with its OFL licence file.
- `src/server/` — everything private: the data access layer (`dal/`), the database (`db/`: schema, client, migration runner, triggers, fixture import), the judging engine (`judging/`), and the cross-cutting modules: `authz.ts`, `mutate.ts`, `audit.ts`, `session.ts`, `openapi.ts`, `webhooks.ts`, `signing.ts`, `rate-limit.ts`, `http.ts`, `errors.ts`, `boot.ts`, `checker.ts`.
- `src/instrumentation.ts` — the Next hook that starts the boot.
- `drizzle/` — the SQL migrations.
- `scripts/` — for operators, in the image too: `backup.mjs` and `restore.mjs` (README, "Running it for a real event") and `verify-record.mjs`, which checks a signed record offline.
- `tests/` — vitest suites, including the boundary and API registry tests; the hand check for the tiers run.py does not verify is `tests/isolation_check.py`.

## Where to change what

- Add a permission rule: an entry in the `Action` and `Resource` unions and a case in `authorize()` (`src/server/authz.ts`), called from a `mutate()`/`guardRead()` DAL function.
- Add a JSON route: the handler under `src/app/api/` plus its `OPERATIONS` entry in `src/server/openapi.ts` — the registry test fails until the two agree; new body shapes go in `src/server/dal/inputs.ts`.
- Add a mutation: a DAL function that calls `mutate()` (`src/server/mutate.ts`) with `load` and `run`; the audit row and webhook queueing follow on their own.
- Add a table: define it in `src/server/db/schema.ts`, generate the migration into `drizzle/`, and touch it only from a module under `src/server/dal/`.
- Make an action webhook-able: nothing extra. Every audited row that carries an event id can be subscribed to by action name or `*` on the organizer's Integrations tab; platform-wide rows queue nothing.
- Add an export file: `EXPORT_FILES` in `src/server/dal/exports.ts`.
- Add a rate limit: a key and a `Limit` in `LIMITS` (`src/server/rate-limit.ts`).
- Change sessions, cookies, API tokens or passwords: `src/server/session.ts`.
- Add a boot step: `boot()` in `src/server/boot.ts`.
