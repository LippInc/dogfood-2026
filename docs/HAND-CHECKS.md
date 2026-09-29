# Checking T3 and T4 by hand

The README's "Beyond the checker" table in full: for every T3 and T4 bullet from the event site, where it lives,
which checks of `tests/isolation_check.py` cover it (Section C is in `tests/isolation_t4.py`; the output of a
clean run is `isolation-report.txt`), and how to see it yourself. Paths assume the seeded event,
`sample-hack-2026` (id `evt_01`), on `http://localhost:8080`. The voting rules themselves are stated once, in
[`FEATURES.md`, "Community vote"](FEATURES.md#community-vote).

## T3: Community voting (email gated, link based or authenticated)

- **Where:** organizer, Voting tab; voters, `/events/sample-hack-2026/vote` and `/vote/<code>`.
- **Checks:** B1, B3, B4, B6.
- **By hand:** the sample event's vote is open from the first start in demo mode (README tour, step 4). "Email
  gated" is the voter list by address, with one personal link each.

## T3: Project comments

- **Where:** each project page; `GET/POST /api/projects/<id>/comments`.
- **Checks:** B8: post, the organizer hides it with a reason, the reason stays in place; unhide; only the author
  deletes, and not while hidden.

## T3: Results hidden during the voting window

- **Where:** `GET /api/events/evt_01/community`, `GET /api/events/evt_01/voting`.
- **Checks:** B2, B5: while the window is open the public count is `null` for everyone and live only for
  organizers (403 for a participant); B10 after. The judged results never show during the vote either:
  publishing closes it (vitest, `publishing ends the community vote`).

## T3: Randomized project ordering on ballots

- **Where:** each voter's ballot, seeded per voter.
- **Checks:** B4: two ballots, two different orders.

## T3: Anti abuse (rate limits, duplicate detection, audit trail)

- **Where:** limits on ballots, link entries, comments and sign-in; no signed-in vote for your own team's
  project; one ballot per person the portal can name; the open link's ballots counted apart; flags on the
  organizer's Voting tab; the audit log.
- **Checks:** B3 (an own-project pick is 422), B5 (the open link counted apart, and the choice fixed once ballots
  are in: 409), B7, B9 (429 with `Retry-After`), B10 (the open link's ballot apart in the closed count), B12 (every
  step is in the audit log).

## T4: REST API and webhooks

- **Where:** OpenAPI 3.1 at `/api/openapi.json`, readable at `/api-docs`; API tokens at `/account/tokens`;
  webhooks on the organizer's Integrations tab ([`FEATURES.md`, "API and webhooks"](FEATURES.md#api-and-webhooks)).
- **Checks:** C1 to C3.
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
- **Checks:** C4 publishes over the API and issues them.
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
- **Checks:** C6.
- **By hand:** put the snippet in an `.html` file and open it in a browser (from disk or any site): the gallery
  appears and sizes itself. `curl -sI localhost:8080/embed/sample-hack-2026` shows `frame-ancestors * file:`;
  every other page answers `frame-ancestors 'none'`.

## T4: Bulk import and export

- **Where:** export at every stage: scores, projects, normalized ranking and audit log as CSV, `event.json`, and
  `fixtures.json` in the organizers' own fixture format; import on Your events or `POST /api/imports`
  ([`FEATURES.md`, "Import and export"](FEATURES.md#import-and-export)).
- **Checks:** C7 (export, then an import that changes nothing), C8 (a new event imported and one person walked in
  by a personal link).
- **By hand:** export `fixtures.json` from the Integrations tab and import it on a fresh portal: the same tables
  and a byte-identical `normalized.csv`, as long as no decision has been made (`tests/import-claims.test.ts` does
  exactly this).
