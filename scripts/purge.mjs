// Remove what the portal keeps about people once it has done its job. Inside the container:
//
//   docker compose exec portal node scripts/purge.mjs              (shows what it would remove)
//   docker compose exec portal node scripts/purge.mjs --yes        (removes it)
//   docker compose exec portal node scripts/purge.mjs --days 30 --yes
//
// It removes, older than --days (default 90, by when the row was written):
//   - the mail log (outbox): each message's address, subject and body (its links were blanked when it was sent);
//   - webhook deliveries that are finished (delivered, or failed for good): the payload sent and the receiver's answer.
//     Pending ones stay, so nothing waiting to be sent is lost.
// and, whatever their age:
//   - the voters' address and browser hashes of every event whose community vote has closed (its window ended, or
//     its results were published). They only served to flag ballots from the same network address and browser while
//     ballots could still be set aside; the count does not change, the flags beside it go;
//   - password sign-in sessions that have ended, and rate-limit buckets idle for over an hour (the portal also
//     removes these itself, at every start and every hour).
//
// It never touches the audit log (append-only; its triggers refuse edits), scores, ballots, comments or accounts,
// and it writes no audit row: it works on the file, outside the portal. Take a backup first (scripts/backup.mjs)
// if you may want the rows back. Uses DATABASE_PATH, with the portal's own default (./data/portal.db; the image
// sets /data/portal.db). Safe while the portal runs: each part is one short write transaction.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--yes");
const daysAt = args.indexOf("--days");
const days = daysAt >= 0 ? Number(args[daysAt + 1]) : 90;
const known = new Set(["--yes", "--days"]);
const unknown = args.filter((a, i) => !known.has(a) && !(daysAt >= 0 && i === daysAt + 1));
if (unknown.length || !Number.isInteger(days) || days < 0 || days > 3650) {
  console.error("Usage: node scripts/purge.mjs [--days N] [--yes]   (N: whole days from 0 to 3650, default 90; without --yes nothing is removed)");
  process.exit(2);
}

const file = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "portal.db");
if (!fs.existsSync(file)) {
  console.error(`No database at ${file}.`);
  process.exit(2);
}

const now = new Date();
const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
const nowIso = now.toISOString();
const SLOWEST_REFILL_MS = 3_600_000;

const parts = [
  {
    what: `mail log messages written before ${cutoff.slice(0, 10)}`,
    count: "SELECT count(*) AS n FROM outbox WHERE julianday(created_at) < julianday(@cutoff)",
    run: "DELETE FROM outbox WHERE julianday(created_at) < julianday(@cutoff)",
  },
  {
    what: `finished webhook deliveries written before ${cutoff.slice(0, 10)}`,
    count: "SELECT count(*) AS n FROM webhook_deliveries WHERE status IN ('delivered', 'failed') AND julianday(created_at) < julianday(@cutoff)",
    run: "DELETE FROM webhook_deliveries WHERE status IN ('delivered', 'failed') AND julianday(created_at) < julianday(@cutoff)",
  },
  {
    what: "voters' address and browser hashes in events whose vote has closed",
    count: `SELECT count(*) AS n FROM voters v JOIN events e ON e.id = v.event_id
            WHERE (v.ip_hash IS NOT NULL OR v.agent_hash IS NOT NULL)
              AND (e.results_published_at IS NOT NULL OR (e.voting_close_at IS NOT NULL AND julianday(e.voting_close_at) <= julianday(@now)))`,
    run: `UPDATE voters SET ip_hash = NULL, agent_hash = NULL
          WHERE (ip_hash IS NOT NULL OR agent_hash IS NOT NULL)
            AND event_id IN (SELECT id FROM events WHERE results_published_at IS NOT NULL OR (voting_close_at IS NOT NULL AND julianday(voting_close_at) <= julianday(@now)))`,
  },
  {
    what: "ended password sign-in sessions",
    count: "SELECT count(*) AS n FROM sessions WHERE kind = 'login' AND julianday(expires_at) <= julianday(@now)",
    run: "DELETE FROM sessions WHERE kind = 'login' AND julianday(expires_at) <= julianday(@now)",
  },
  {
    what: "idle rate-limit buckets",
    count: "SELECT count(*) AS n FROM rate_buckets WHERE at < @idle",
    run: "DELETE FROM rate_buckets WHERE at < @idle",
  },
];

const params = { cutoff, now: nowIso, idle: now.getTime() - SLOWEST_REFILL_MS };
const db = new Database(file, { fileMustExist: true });
db.pragma("busy_timeout = 5000");
let total = 0;
try {
  for (const p of parts) {
    const n = db.transaction(() => {
      const found = db.prepare(p.count).get(params).n;
      if (apply && found) db.prepare(p.run).run(params);
      return found;
    })();
    total += n;
    console.log(`${apply ? "removed" : "would remove"} ${String(n).padStart(6)}  ${p.what}`);
  }
} finally {
  db.close();
}
console.log(apply ? `done: ${total} rows changed in ${file}` : `nothing removed (dry run): add --yes to remove the ${total} rows above`);
