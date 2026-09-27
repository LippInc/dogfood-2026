import "server-only";
import path from "node:path";
import { openAdminSetup } from "./admins";
import { checkerSessionsEnabled, checkerToml, demoModeRefusal, ensureDemoOrganizer, seedCheckerSessions, seedDemoVote, writeCheckerFile, type DemoGrants } from "./checker";
import { databasePath, handle, type Handle } from "./db/client";
import { importFixtures, loadFixtureFile } from "./db/import-fixtures";
import { runMigrations } from "./db/migrate";
import { requireEvent } from "./dal/events";
import { ensureSigningKey } from "./signing";
import { startWebhookWorker } from "./webhooks";
import { nowIso } from "./util";

// Runs once per server start, from instrumentation.ts: migrate, re-assert the
// triggers, import the fixtures (idempotent; FIXTURES_PATH=none skips them), open
// the administrator setup for ADMIN_EMAILS, upsert the checker sessions, and
// print the readiness lines. Everything here is synchronous better-sqlite3 work.
// Next opens its port before this finishes; the line to wait for is ours.

/** The boot line's account of what demo mode handed out and turning it off ended; empty when nothing. */
function demoGrantsLine(r: DemoGrants): string {
  const parts = [
    r.apiTokens ? `${r.apiTokens} API ${r.apiTokens === 1 ? "token" : "tokens"} revoked` : "",
    r.webhooks ? `${r.webhooks} ${r.webhooks === 1 ? "webhook" : "webhooks"} turned off` : "",
    r.claimLinks ? `${r.claimLinks} unused account ${r.claimLinks === 1 ? "link" : "links"} deleted` : "",
    r.judgeInvites ? `${r.judgeInvites} judge ${r.judgeInvites === 1 ? "invite" : "invites"} revoked` : "",
  ].filter(Boolean);
  return parts.length ? `; made as a demo identity: ${parts.join(", ")}` : "";
}

export function fixturesPath(): string {
  return process.env.FIXTURES_PATH ?? path.join(process.cwd(), "fixtures.json");
}

/**
 * The start-up fixture import (idempotent); returns the fixture event's id, or null
 * when FIXTURES_PATH=none asks for a portal that starts empty.
 */
export function bootFixture(h: Handle, now: string): string | null {
  const file = fixturesPath();
  if (file === "none") {
    console.log("[boot] no fixture import (FIXTURES_PATH=none): the portal starts without the sample event");
    return null;
  }
  const { fixture, sha256 } = loadFixtureFile(file);
  const report = importFixtures(h.db, fixture, { source: path.basename(file), sha256, now });
  const inserted = Object.values(report.inserted).reduce((a, b) => a + b, 0);
  console.log(
    inserted > 0
      ? `[boot] fixtures imported from ${path.basename(file)}: ${report.inserted.projects} projects, ${report.inserted.scores} scores, ${report.inserted.users} people`
      : `[boot] fixtures already imported (${path.basename(file)}, sha256 ${sha256.slice(0, 12)}); nothing changed`,
  );
  for (const s of report.skipped) console.warn(`[boot] fixture ${s.kind} ${s.id} skipped: ${s.reason}`);
  return report.eventId;
}

export async function boot(): Promise<void> {
  const started = Date.now();
  const h = handle();
  const triggers = runMigrations(h);
  if (triggers.restored.length > 0) console.warn(`[boot] triggers restored: ${triggers.restored.join(", ")}`);

  const now = nowIso();
  const eventId = bootFixture(h, now);
  const key = ensureSigningKey(h.db, now);
  console.log(`[boot] records are signed with Ed25519 key ${key.id}; public key at /.well-known/dogfood-keys.json`);

  const base = process.env.PUBLIC_URL ?? "http://localhost:8080";
  const event = eventId ? requireEvent(h.db, eventId) : null;
  const lines: string[] = [];
  if (checkerSessionsEnabled()) {
    if (!eventId || !event) throw new Error("SEED_CHECKER_SESSIONS=true needs the fixture event: set FIXTURES_PATH to a fixture file, or turn the flag off");
    ensureDemoOrganizer(h.db, eventId, now);
    const seeded = seedCheckerSessions(h.db, eventId, now);
    if (seeded.enabled) {
      const written = writeCheckerFile(path.dirname(databasePath()), checkerToml(seeded.identities, event));
      lines.push("seeded. test logins:");
      for (const i of seeded.identities) lines.push(`  ${i.label.padEnd(12)} Cookie: session=${i.token}`);
      lines.push(`  (who: ${seeded.identities.map((i) => `${i.label} = ${i.name}`).join(", ")})`);
      lines.push(`  the [auth] and [routes] blocks for .dogfood.toml are in ${written}`);
    }
    const vote = seedDemoVote(h.db, eventId, now);
    if (vote.code && vote.closesAt && Date.parse(vote.closesAt) > Date.now()) {
      lines.push(`community vote (demo): open until ${vote.closesAt.slice(0, 16).replace("T", " ")} UTC; sign in, or use the open link ${base}/vote/${vote.code}`);
    }
  } else {
    const seeded = seedCheckerSessions(h.db, eventId ?? "", now);
    const refusal = demoModeRefusal();
    lines.push(
      `${refusal ? `checker sessions REFUSED: ${refusal}; set your own DOGFOOD_SEED_SECRET, or SEED_CHECKER_SESSIONS=false` : `checker sessions are OFF (SEED_CHECKER_SESSIONS is not "true")`}${!seeded.enabled && seeded.removed ? `; removed ${seeded.removed} left from an earlier boot` : ""}${!seeded.enabled && seeded.signedOut ? `; signed out ${seeded.signedOut} demo sign-in ${seeded.signedOut === 1 ? "session" : "sessions"}` : ""}${!seeded.enabled && seeded.demoted ? "; the demo organizer is no longer an administrator" : ""}${!seeded.enabled ? demoGrantsLine(seeded.revoked) : ""}.`,
    );
  }
  const setup = openAdminSetup(h.db);
  if (setup) {
    lines.push(`administrator setup: open ${base}/sign-up?setup=${setup.code}`);
    lines.push(`  and sign up as ${setup.waiting.join(" or ")} (only this link makes an administrator; it works once, and each start prints a new one while a named address has no account)`);
  }
  startWebhookWorker();
  lines.push(`portal ready: ${event ? `${base}/events/${event.slug}` : `${base}/sign-up`}  (boot took ${Date.now() - started} ms)`);
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
