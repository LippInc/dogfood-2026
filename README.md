# Dogfood portal

A self-hostable hackathon submission and judging portal, built for Dogfood 2026.
Work in progress: this README grows with the build.

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

## Check it

```bash
python run.py .dogfood.toml
```

## What it does not do yet

- Judge scores, peer-score refusal and CSV export (the T2 checks) are not built yet.
- Signing up, teams and invite links, event creation and editing a project are not built yet.
- Password sign-in exists, but no account has a password yet; the demo sign-in
  buttons on `/sign-in` are the way in while `SEED_CHECKER_SESSIONS=true`.

## Licence

MIT, see `LICENSE`. The fonts in `src/fonts/` are under the SIL Open Font
License 1.1; each licence sits next to its font.
