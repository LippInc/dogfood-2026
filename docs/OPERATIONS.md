# Operating the portal

For someone running it for a real event. The first steps (the five settings and the setup link) are in the
README, "Running it for a real event"; this page has everything after them.

## People and accounts

Judges and teams join through the links the portal gives you; co-organizers sign up and you add them by their
email on the event's **Settings** tab (an account that already has a place in an event you do not run is added
only by the administrator). Someone who forgets their password asks you: on **Accounts** (next to Portal log)
you make a one-time link for their address, which works once, within a day, and signs that account out
everywhere when the new password is set. Accounts are not email-verified, so the address alone proves nothing:
without the setup link a sign-up with a named address is refused, and an account that already exists is never
promoted, so name an address that has no account yet in `ADMIN_EMAILS`.

An administrator creates an event on **Your events** (dates, tracks, prizes, rubric) or imports one from a
`fixtures.json`-format file (up to 2,000 projects and 16,000 reviews per file; a bigger event goes in over several
files).

Running the same event again (next month, next year): **Your events**, **New event**, and pick last time's event
under "Start from the settings of". Give the new one its name and dates; its tracks, rubric, questions to teams,
what teams fill in, team size, prizes, certificate places, judging mode and voting rules come from the old one
(details in [`FEATURES.md`](FEATURES.md#events-and-teams)), and nothing of its people, teams, projects or scores
does. The list shows only events you organize: an administrator who does not organize last year's event asks one
of its organizers to add them first. Re-importing an event's own `fixtures.json` is not the way: the file keeps the
event's id, so it adds to that same event.

## Demo mode off

Why `SEED_CHECKER_SESSIONS: "false"`: the checker's four session tokens are public in `.dogfood.toml`. They are
derived from `DOGFOOD_SEED_SECRET`, whose default (`dogfood-2026-public-demo-secret`) is documented on purpose;
set your own wherever the portal can be reached. The portal enforces that: on the default secret (or none) it
starts only as the local demo, the flag on and `PUBLIC_URL` a local address or unset. With the flag off it refuses to
start whatever `PUBLIC_URL` says (a portal behind a reverse proxy may leave it unset), and on an address that is not
local it refuses flag on or off; the refusal says what to set: a long random string, such as the output of
`openssl rand -hex 32`. Developers running `next dev` without the compose file set `SEED_CHECKER_SESSIONS=true` (the
local demo) or a secret of their own. With the flag
off, each start also signs out every session the demo sign-in buttons made, takes the demo organizer's
administrator rights, and ends what anyone acting as a demo identity handed out: their API tokens are revoked,
their webhooks turned off, their unused account and password reset links deleted and their open judge invites
revoked. So turning demo mode off works on a volume that ran with it on. The same secret salts the hashes of
voters' network addresses (`DATA-MODEL.md`, "Privacy"), so a real event sets its own in any case.

## Settings

Each is an environment variable in `docker-compose.yml`.

| Setting | What it does |
|---|---|
| `SEED_CHECKER_SESSIONS` | `"true"` seeds the checker's four sessions and the demo sign-in buttons; `"false"` for a real event (boot then removes any left from before). On a `PUBLIC_URL` that is not a local address demo mode is refused, since its buttons make anyone the demo organizer (an administrator); `PUBLIC_DEMO=true` with your own secret runs a public demo on purpose |
| `DOGFOOD_SEED_SECRET` | Derives the checker sessions, salts the voters' address hashes and seals the signing key in the database; set your own, and keep it: on the default (or none) the portal starts only as the local demo (`SEED_CHECKER_SESSIONS: "true"` on a local address) and refuses to start otherwise; under a new one the portal starts a new signing key (records signed before still verify) |
| `PUBLIC_URL` | The address people use (for example `https://hack.example.org`): it goes into the reminder messages for judges, the API reference, the embed code, an exported uploaded picture's address, and every signed record as its issuer, so set it before issuing records. A trailing slash is ignored (`https://hack.example.org/` works the same). Links made on screen (invitations, voter and claim links) use the address in the organizer's browser; mailed ones start with `PUBLIC_URL`, so email needs it set |
| `SMTP_URL`, `MAIL_FROM` | Email, off by default: unset, nothing is mailed and no network is needed. Set (`smtp://user:password@mail.example.org:587`, or `smtps://`) with the address mail comes from, the portal mails each judge invitation that has an address, each listed voter's link, each claim link and each password reset link as it is made; the screen still shows the link once. The outbox (Integrations page, `GET /api/events/{event}/outbox`, read 100 at a time, newest first, with `before` for older ones) keeps each message with its link blanked, so no working key is stored and a mailed link cannot be sent again: make a new one. Each message is recorded before it is sent, so none goes out unrecorded, and then shows one of three results: sent (the mail server took it), failed (it did not go out, or its address was refused before sending; the reason is shown; an address the outbox itself cannot hold, such as `bo@`, is named on the page but not recorded) or may have arrived (the connection broke after hand-over: ask before making a new link, which would replace it). For its first minute a message still being sent says so; after that, one with no answer says no answer recorded (the minute fits the default mail timeouts: with longer timeouts written into `SMTP_URL`, or a server that answers each step slowly, a send can still be under way then and read "no answer recorded" until its result is written). The page that made the links waits at most 5 seconds for the mail server, then shows the links while the sends finish. Inviting a judge's address again replaces its open invitation, and the older link stops working |
| `COOKIE_SECURE` | Whether the sign-in and voter cookies are marked `Secure` (sent over HTTPS only). Unset, they are when `PUBLIC_URL` starts with `https://`, so an HTTPS portal needs nothing more; `"true"` or `"false"` decides it outright, for example `"true"` behind an HTTPS proxy with no `PUBLIC_URL` set. The offline run on `http://localhost:8080` leaves them plain, as a browser needs over http |
| `TRUST_PROXY_HOPS` | How many reverse proxies stand in front of the portal, each appending to `X-Forwarded-For` (usually `1`). Unset, the client address is the connection's own and any `X-Forwarded-For` a client sends is ignored; set it only when that many proxies really are in front, or a client can name its own address |
| `SIGN_IN_LIMIT_PER_ADDRESS` | Sign-ups and password sign-ins together that one network address may make in 10 minutes; default `300`. A venue or office puts everyone behind one address, so raise it for a crowd bigger than about 100 on one wifi (each one costs the server a password hash, some 70 ms of one core). The limits on guessing one account's password (10 tries per email address per address in 15 minutes, 100 per hour overall) do not change with it. A value that is not a whole number from 1 to 100000 stops the portal at start |
| `SESSION_DAYS` | How many days a password sign-in lasts before the person signs in again; default `14`, up to `366`. Set it to cover the judging window when judges work over a month, so nobody is signed out mid-review. It counts from the sign-in, and a change applies to sign-ins made after it. A value that is not a whole number from 1 to 366 stops the portal at start |
| `WEBHOOKS_ALLOW_PRIVATE` | `"true"` lets webhooks reach private and local addresses; leave it unset unless the receiver is on your own network |
| `ADMIN_EMAILS` | Addresses (comma separated) for the portal's administrators, who create and import events and see every event as its organizers do (the organizers' published role matrix gives ADMIN every column, and each column there is a right to read); changing an event stays with its organizers. Each signs up through the one-time setup link the portal prints in its log at start; a link works once, and each start prints a new one while a named address has no account yet. The sign-up's audit row records it |
| `DATABASE_PATH`, `FIXTURES_PATH` | Where the database lives (default `/data/portal.db`, in the volume) and which fixture file the first start imports (once per file: a start with the same file imports nothing, so edits and removals stand; a changed file adds only its new rows. A changed file the event here refuses (a team past its size, a second project for a team, a judge on the team they review, a new criterion after scoring, a rubric or questions past the Rubric and Questions tabs' limits) or one that adds to an event whose results are published imports nothing at all: the start logs the file, the row and the rule, and the portal starts with the data it has. A refused file for an event not here yet is logged the same way while the volume holds other events, and the portal starts with those (in demo mode without checker sessions that start, as they need the fixture event); on a volume with no event yet (a fresh one) it stops the start, naming the file, the row and the rule, and the line repeats (below the table) until the file is fixed or `FIXTURES_PATH` points at another. A missing file or one that is not JSON stops the start); `"none"` starts without the sample event |

A start stopped by a setting (a value out of range, a fixture file it cannot use, the default secret on an address
that is not local) prints its reason and exits. Under the shipped `docker-compose.yml` (`restart: unless-stopped`)
Docker then starts the container again, after a pause that grows with each try (a few seconds at first, near half a
minute after ten tries), so the same line repeats in `docker compose logs` until the setting is fixed. The portal
answers nothing meanwhile, and `docker compose ps` shows it restarting.

## Network and health

`docker-compose.yml` publishes the portal on `127.0.0.1:8080` only; put it behind a reverse proxy that terminates
HTTPS, and set `TRUST_PROXY_HOPS`. `GET /api/health` answers 200 `{"ok":true,"events":<n>}` once the database is
open and holds an event (at once with `FIXTURES_PATH: "none"`) and the start-up warm-up is done (the same moment
as the `portal ready` line), and 503 before. It also answers 503, with a `problem` naming the folder, when the
volume takes no writes (full or read-only; it writes a 4 KB file there at most every 30 s): reads would still work
while every change failed. The compose healthcheck uses it, and a proxy or a monitor can too.

## Backup and restore

Back up while it runs: the database with SQLite's online backup, and the uploaded pictures with it, into one
folder in the volume:

```bash
docker compose exec portal node scripts/backup.mjs
```

It prints the folder's path, for example `/data/backups/portal-20260927T013000Z` (`portal.db` and `uploads/`). A
backup in the volume goes with the volume (`docker compose down -v`, a lost disk), so copy each one off the
machine: `docker compose cp portal:/data/backups/portal-20260927T013000Z .`. Only the newest 7 stay in the volume
(`BACKUP_KEEP`, for example `docker compose exec -e BACKUP_KEEP=14 portal node scripts/backup.mjs`); older ones are
deleted once the new one checks out. A backup is written under `portal-<time>.partial` and takes its name only
after its integrity check passes, so one that fails is removed and never pushes a good one out. To restore, stop the portal, put the folder back in the volume, and let the
restore script replace the database, drop the old write-ahead log (copying the file over by hand would let SQLite
replay that log onto it) and bring the pictures back; the pictures in use are moved aside to
`/data/uploads-before-restore-<time>`, to delete once the portal looks right:

```bash
docker compose stop
docker compose cp ./portal-20260927T013000Z portal:/data/restore
docker compose run --rm --no-deps portal node scripts/restore.mjs /data/restore
docker compose start
```

A backup made before backups were folders is a single `.db` file; restoring it brings the database back and
leaves the pictures as they are (the next start deletes the ones no project names).

## Personal data

The portal's `/privacy` page ("What we keep") lists everything it stores about people, how long each thing stays
and what removes it; DATA-MODEL.md carries the same table. It removes two things by itself, at every start and
every hour: password sign-in sessions past their end, and rate-limit buckets idle for over an hour (a bucket's key
is a keyed hash under `DOGFOOD_SEED_SECRET`, never an email or network address). The rest is yours to clear once it
has done its job:

```bash
docker compose exec portal node scripts/purge.mjs              # shows what it would remove
docker compose exec portal node scripts/purge.mjs --yes        # removes it
docker compose exec portal node scripts/purge.mjs --days 30 --yes
```

It removes the mail log and finished webhook deliveries older than `--days` (default 90), and the voters' address
and browser hashes of every event whose vote has closed. It never touches the audit log, scores, ballots, comments
or accounts, and writes no audit row, so take a backup first if you may want the rows back. Backups hold a copy of
everything: the newest 7 stay in the volume, and those copied off the machine are yours to delete. The portal cannot
yet erase one person (see the README's "What it does not do yet").

## One process per volume

Run one portal process per data volume: limits such as team size, rate limits and accepting an invitation hold
because one process makes its changes one at a time. The portal keeps `portal.lock` next to the database while it
runs, and a second process on the same volume refuses to start and names the first; a lock left by a process that
died is taken over 20 seconds after its last refresh (at once by the same container restarting), and a clean stop
removes it.

## Upgrading

`git pull` and `docker compose up --build`: migrations run at every start, and a fixture file is imported once, so
what the organizers changed or removed stands; a changed fixture file imports only its new rows. A fixture file is
recognised by its SHA-256 before its format is checked, so a file an earlier version imported never stops a later
start, even when the newer portal holds imports to tighter limits.
