# Checking T3 and T4 by hand

The README's "Beyond the checker" table in full: for every T3 and T4 bullet from the event site, where it lives,
which checks of `tests/isolation_check.py` cover it (35 checks: A1 to A8 on who may read and change judging and start an event from another's settings, B1 to
B15 on T3, and Section C, C1 to C12, in `tests/isolation_t4.py`; the output of a clean run is
`isolation-report.txt`, each line starting with its check's number), and how to see it yourself. Paths assume the seeded event, `sample-hack-2026` (id
`evt_01`), on `http://localhost:8080`. The voting rules themselves are stated once, in [`FEATURES.md`, "Community
vote"](FEATURES.md#community-vote).

## Running the hand check

`python tests/isolation_check.py .dogfood.toml` runs all 35 checks against the portal at the `base_url` that
`.dogfood.toml` names.

- It needs the standard library only; Section C, for T4 and pairwise judging, is in `tests/isolation_t4.py`; Node,
  when installed, adds the offline record check.
- It writes votes and comments and publishes the sample event's results, so run it on a fresh portal, after run.py;
  it takes under a minute.
- Checks B2, B5, B11 to B15, C1, C2, C6, C7 and C9 to C12 were each shown to fail on a copy of the portal with the
  defect they look for planted, so their passes mean the feature works, not only that a page answered.

**The signed webhook request itself** needs a receiver the portal may reach, and the portal refuses private targets
unless `WEBHOOKS_ALLOW_PRIVATE=true`, which would make C3 wrong. So a second script checks it:
`python tests/webhook_live_check.py .dogfood.toml`, on a portal started with that setting, runs a receiver and
checks what arrives (the header in the script says how; on Linux, give the portal service
`extra_hosts: ["host.docker.internal:host-gateway"]` and run the check with `--host 0.0.0.0`).

## T3: Community voting (email gated, link based or authenticated)

- **Where:** organizer, Voting tab; voters, `/events/sample-hack-2026/vote` and `/vote/<code>`.
- **Checks:** B1, B3, B4, B6.
- **By hand:** the sample event's vote is open from the first start in demo mode (README tour, step 4). "Email
  gated" is the voter list by address, with one personal link each.

## T3: Project comments

- **Where:** each project page; `GET/POST /api/projects/<id>/comments`.
- **Checks:** B8: post, the organizer hides it with a reason, the reason stays in place for the author; a visitor and
  another judge get one comment fewer; unhide; only the author deletes, and not while hidden.

## T3: Results hidden during the voting window

- **Where:** `GET /api/events/evt_01/community`, `GET /api/events/evt_01/voting`.
- **Checks:** B2, B5: while the window is open the public count is `null` for everyone (a JSON answer, never an
  error page) and live only for organizers (403 for a participant); B10 after. B11: before publishing,
  `GET /api/events/evt_01/results` answers `{"published": false}` and nothing more, and the results page holds no
  score. The judged results never show during the vote either: publishing closes it (vitest, `publishing ends the
  community vote`).

## T3: Randomized project ordering on ballots

- **Where:** each voter's ballot, seeded per voter.
- **Checks:** B4: two ballots, two different orders; B13: account, listed and open-link ballots each in the
  voter's own order, the same on every look, none in the gallery's.

## T3: Anti abuse (rate limits, duplicate detection, audit trail)

- **Where:** limits on ballots, link entries, comments and sign-in; no signed-in vote for your own team's
  project; one ballot per person the portal can name; the open link's ballots counted apart; flags on the
  organizer's Voting tab; the audit log.
- **Checks:** B3 (an own-project pick is 422), B5 (the open link counted apart, and the choice fixed once ballots
  are in: 409), B7, B9 (429 with `Retry-After`), B14 (ballot saves and password sign-ins limited too, whatever
  `X-Forwarded-For` says), B15 (past 60 refusals in 10 minutes a person gets 429 and no more audit rows), B10 (the
  open link's ballot apart in the closed count), B12 (every step is in the audit log).

## T4: REST API and webhooks

- **Where:** OpenAPI 3.1 at `/api/openapi.json`, readable at `/api-docs`; API tokens at `/account/tokens`;
  webhooks on the organizer's Integrations tab ([`FEATURES.md`, "API and webhooks"](FEATURES.md#api-and-webhooks)).
- **Checks:** C1 to C3 (C1 with a real API token made at `POST /api/tokens`, then revoked: 401), C10 (a delivery
  that cannot be sent is tried again 10 s and then 60 s later); `tests/webhook_live_check.py` for the signed
  request itself, a retry after a 500 and a rotated secret. That one needs a receiver the portal may reach, so it
  runs on a portal started with `WEBHOOKS_ALLOW_PRIVATE=true` (which would make C3 wrong): the header in the
  script says how.
- **By hand, the API:** `curl -H "Authorization: Bearer <token>" localhost:8080/api/events/sample-hack-2026/overview`,
  where `<token>` is the part after `session=` on the organizer line of `.dogfood.toml` (a session token works as
  a Bearer too): 200; with the participant's token 403; with no header 401.
- **By hand, a webhook arriving:** set `WEBHOOKS_ALLOW_PRIVATE: "true"` in `docker-compose.yml` (local targets are
  refused otherwise) and run `docker compose up -d` again; add a webhook on Integrations with the URL
  `http://host.docker.internal:9911/`; run `node scripts/webhook-receiver.mjs --secret <the secret it shows>` on
  your machine and press "Send a test": each delivery prints with `signature: valid` (Linux needs one more line,
  in the script's header).

## T4: Certificate and record generation

- **Where:** after publishing, a certificate for each member of a submitting team and a record for each judge, at
  `/records/<id>`, printable ([`FEATURES.md`](FEATURES.md#signed-certificates-and-judging-records)).
- **Checks:** C4 publishes over the API and issues them; C11 checks every certificate's places and community-vote
  win against the published results and the vote.
- **By hand:** publish the sample event (Overview: make the three decisions, tick the box, Publish), then the
  Results tab, "Issue every record", and open one.

## T4: Signed, publicly verifiable judge participation records

- **Where:** Ed25519 over the record's canonical JSON; the public key at `/.well-known/dogfood-keys.json` (open to
  any site); checked in the browser with WebCrypto on each record page and on `/verify`, by
  `POST /api/records/verify`, or offline with `node scripts/verify-record.mjs <record URL or file> [--keys <saved key file>]`.
- **Checks:** C4 (a changed record is `bad_signature`), C5 (the script: exit 0, then 1 for the changed copy).
- **By hand:** download a record, change one letter, paste it into `/verify`: "Not valid" from the browser and
  the portal.

## T4: Embeddable gallery widget

- **Where:** `<script src="http://localhost:8080/embed.js" data-event="sample-hack-2026" async></script>`; the
  frame is `/embed/sample-hack-2026`.
- **Checks:** C6 (the frame holds every gallery project and its link; a dozen other pages refuse framing).
- **By hand:** put the snippet in an `.html` file and open it in a browser (from disk or any site): the gallery
  appears and sizes itself. `curl -sI localhost:8080/embed/sample-hack-2026` shows `frame-ancestors * file:`;
  every other page answers `frame-ancestors 'none'`.

## T4: Bulk import and export

- **Where:** export at every stage: scores, projects, normalized ranking and audit log as CSV, `event.json`, and
  `fixtures.json` in the organizers' own fixture format; import on Your events or `POST /api/imports`
  ([`FEATURES.md`, "Import and export"](FEATURES.md#import-and-export)).
- **Checks:** C7 (export, then an import that changes nothing; once results are published a file that would add
  is 409, and a file with one comment the event does not hold is 409 `new_event_only`), C8 (a new event imported and one person walked in by a personal link), C12 (an organizer who is not an
  administrator gets no link for someone in an event they do not run, checked again when the link is used).
- **By hand:** export `fixtures.json` from the Integrations tab and import it on a fresh portal: the same event,
  decisions, ballots, comments and published results included; exported there it is the same file, with a
  byte-identical `normalized.csv` (`tests/event-round-trip.test.ts` does exactly this).

## The stability check

For developers: `node tools/stability-check.mjs http://localhost:8080 --container <the portal's container>` checks
that nothing on screen jumps, shakes or shifts while people type, hover, open menus or wait through a live refresh
(needs Chrome or Chromium; `--self-test` first proves it catches planted bugs; it changes a judge's scores, so use a
scratch portal).
