import "server-only";
import path from "node:path";
import { checkerSessionsEnabled, checkerToml, ensureDemoOrganizer, seedCheckerSessions, writeCheckerFile } from "./checker";
import { databasePath, handle } from "./db/client";
import { importFixtures, loadFixtureFile } from "./db/import-fixtures";
import { runMigrations } from "./db/migrate";
import { requireEvent } from "./dal/events";
import { ensureSigningKey } from "./signing";
import { nowIso } from "./util";

// Runs once per server start, from instrumentation.ts: migrate, re-assert the
// triggers, import the fixtures (idempotent), upsert the checker sessions, and
// print the readiness lines. Everything here is synchronous better-sqlite3 work.
// Next opens its port before this finishes; the line to wait for is ours.

export function fixturesPath(): string {
  return process.env.FIXTURES_PATH ?? path.join(process.cwd(), "fixtures.json");
}

export async function boot(): Promise<void> {
  const started = Date.now();
  const h = handle();
  const triggers = runMigrations(h);
  if (triggers.restored.length > 0) console.warn(`[boot] triggers restored: ${triggers.restored.join(", ")}`);

  const now = nowIso();
  const file = fixturesPath();
  const { fixture, sha256 } = loadFixtureFile(file);
  const report = importFixtures(h.db, fixture, { source: path.basename(file), sha256, now });
  const inserted = Object.values(report.inserted).reduce((a, b) => a + b, 0);
  console.log(
    inserted > 0
      ? `[boot] fixtures imported from ${path.basename(file)}: ${report.inserted.projects} projects, ${report.inserted.scores} scores, ${report.inserted.users} people`
      : `[boot] fixtures already imported (${path.basename(file)}, sha256 ${sha256.slice(0, 12)}); nothing changed`,
  );
  for (const s of report.skipped) console.warn(`[boot] fixture ${s.kind} ${s.id} skipped: ${s.reason}`);
  const key = ensureSigningKey(h.db, now);
  console.log(`[boot] records are signed with Ed25519 key ${key.id}; public key at /.well-known/dogfood-keys.json`);

  const base = process.env.PUBLIC_URL ?? "http://localhost:8080";
  const event = requireEvent(h.db, report.eventId);
  const lines: string[] = [];
  if (checkerSessionsEnabled()) {
    ensureDemoOrganizer(h.db, report.eventId, now);
    const seeded = seedCheckerSessions(h.db, report.eventId, now);
    if (seeded.enabled) {
      const written = writeCheckerFile(path.dirname(databasePath()), checkerToml(seeded.identities, event));
      lines.push("seeded. test logins:");
      for (const i of seeded.identities) lines.push(`  ${i.label.padEnd(12)} Cookie: session=${i.token}`);
      lines.push(`  (who: ${seeded.identities.map((i) => `${i.label} = ${i.name}`).join(", ")})`);
      lines.push(`  the [auth] and [routes] blocks for .dogfood.toml are in ${written}`);
    }
  } else {
    const seeded = seedCheckerSessions(h.db, report.eventId, now);
    lines.push(
      `checker sessions are OFF (SEED_CHECKER_SESSIONS is not "true")${!seeded.enabled && seeded.removed ? `; removed ${seeded.removed} left from an earlier boot` : ""}.`,
    );
  }
  lines.push(`portal ready: ${base}/events/${event.slug}  (boot took ${Date.now() - started} ms)`);
  console.log(lines.join("\n"));
}

/**
 * Exit instead of serving 500s from a half-seeded database: `docker compose up`
 * then shows the crash and its reason, and the container stops.
 */
export async function bootOrExit(): Promise<void> {
  try {
    await boot();
  } catch (err) {
    console.error("[boot] failed, exiting:", err);
    process.exit(1);
  }
}
