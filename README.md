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

The organizers' suite covers T1 and T2. Our own tests (`npm test`, vitest) cover
the permission rules, the assignment engine, the normalization engine and its
Monte Carlo validation, the audit log's append-only triggers and hash chain.

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
  documented in `JUDGING.md` (draft in progress), and each project's normalized
  score comes with its receipt, judge by judge.
- **Results and exports.** Publishing is locked until every decision is made; it
  stores the exact normalization run it publishes. Teams then see their place,
  score and each review's feedback, judges unnamed. CSV exports (scores,
  projects, normalized ranking, audit log) and a full `event.json` are available
  at every stage.
- **Audit log.** Every change and every refused request is recorded in the same
  transaction as the change; the database refuses edits and deletes of the log,
  and each row carries the hash of the one before.

## Running it for a real event

Set `SEED_CHECKER_SESSIONS: "false"` in `docker-compose.yml`: the checker's four
session tokens are public in `.dogfood.toml`. They are derived from
`DOGFOOD_SEED_SECRET`, whose default (`dogfood-2026-public-demo-secret`) is
documented on purpose; set your own when the flag is on anywhere public.

## What it does not do yet

- No community voting, comments or rate limits (the organizers' T3 tier).
- No documented REST API, webhooks, certificates or embeddable gallery (T4);
  the JSON routes the pages use exist under `/api` but are not a stable API yet.
- No email: invitations and reminders are links the organizer copies and sends.
- Results cannot be unpublished from the interface.
- No calibrated prize probabilities or rank intervals: normalized ranks compare
  within a track, and close scores should be read as ties.
- `ARCHITECTURE.md`, `DATA-MODEL.md` and the final `JUDGING.md` are still to come.

## Licence

MIT, see `LICENSE`. The fonts in `src/fonts/` are under the SIL Open Font
License 1.1; each licence sits next to its font.
