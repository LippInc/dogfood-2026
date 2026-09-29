import "server-only";
import fs from "node:fs";
import path from "node:path";
import { openAdminSetup } from "./admins";
import { checkerSessionsEnabled, checkerToml, demoModeRefusal, ensureDemoOrganizer, seedCheckerSessions, seedDemoVote, startRefusal, writeCheckerFile, type DemoGrants } from "./checker";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { databasePath, handle, type Handle } from "./db/client";
import { events } from "./db/schema";
import { FixtureSchema, importedBefore, importFixtures, type Fixture } from "./db/import-fixtures";
import { claimDataFolder } from "./instance-lock";
import { runMigrations } from "./db/migrate";
import { requireEvent } from "./dal/events";
import { mailProblem } from "./mail";
import { HttpError } from "./errors";
import { settingsProblem } from "./settings";
import { ensureSigningKey } from "./signing";
import { sweepOrphanUploads } from "./uploads";
import { startWebhookWorker } from "./webhooks";
import { nowIso, sha256 as sha256Of } from "./util";
import { selfBase, warmUp, warmUpSteps } from "./warmup";

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
    r.resetLinks ? `${r.resetLinks} unused password reset ${r.resetLinks === 1 ? "link" : "links"} deleted` : "",
    r.judgeInvites ? `${r.judgeInvites} judge ${r.judgeInvites === 1 ? "invite" : "invites"} revoked` : "",
  ].filter(Boolean);
  return parts.length ? `; made as a demo identity: ${parts.join(", ")}` : "";
}

export function fixturesPath(): string {
  return process.env.FIXTURES_PATH ?? path.join(process.cwd(), "fixtures.json");
}

class PublishedEventImport extends Error {}

const fixFile = `set FIXTURES_PATH to a fixture file the portal can read (in the container, for example one mounted into /data), or to "none" to start without the sample event`;
const whichFile = (file: string) => (process.env.FIXTURES_PATH ? `FIXTURES_PATH names ${file}, which` : `The fixture file ${file} (FIXTURES_PATH is not set)`);

/**
 * Read the fixture file as JSON, or stop the start with a message that names the setting and the path: a bare ENOENT
 * says neither which file was meant nor how to fix it. The fixture format is checked after, in bootFixture.
 */
function readFixtureJson(file: string): { raw: unknown; sha256: string } {
  try {
    const text = fs.readFileSync(file, "utf8");
    return { raw: JSON.parse(text) as unknown, sha256: sha256Of(text) };
  } catch (err) {
    const which = whichFile(file);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${which} does not exist: ${fixFile}`);
    if (code === "EISDIR") throw new Error(`${which} is a folder, not a file: ${fixFile}`);
    if (code === "EACCES" || code === "EPERM") throw new Error(`${which} cannot be read (${code}): ${fixFile}`);
    if (err instanceof SyntaxError) throw new Error(`${which} is not valid JSON (${err.message}): ${fixFile}`);
    throw err;
  }
}

/** The event id a JSON file names, before it is known to be a fixture file. */
function namedEventId(raw: unknown): string | null {
  const id = (raw as { event?: { id?: unknown } } | null)?.event?.id;
  return typeof id === "string" ? id : null;
}

/** A Zod refusal in a line: the first problem's place and message, and how many there are. */
function firstProblem(err: z.ZodError): string {
  const issue = err.issues[0];
  const where = issue?.path.length ? issue.path.join(".") : "the top level";
  return `${where}: ${issue?.message ?? "does not match"} (${err.issues.length} ${err.issues.length === 1 ? "problem" : "problems"})`;
}

/**
 * The start-up fixture import (idempotent); returns the fixture event's id when that event is here, or null when
 * FIXTURES_PATH=none asks for a portal that starts empty, or when the file for a new event was refused on a volume
 * that holds other events (the portal starts with those).
 */
export function bootFixture(h: Handle, now: string): string | null {
  const file = fixturesPath();
  if (file === "none") {
    console.log("[boot] no fixture import (FIXTURES_PATH=none): the portal starts without the sample event");
    return null;
  }
  const { raw, sha256 } = readFixtureJson(file);
  const named = namedEventId(raw);
  // A file is imported once. Re-running it at every start (insert-or-ignore) kept the organizers' edits but brought
  // back what they deleted, a judge taken off a track or a member who left a team; a changed file still imports.
  // Decided before the format check: a file imported once never stops a later start, even when a newer portal holds
  // imports to tighter limits than the one that imported it.
  if (importedBefore(h.db, sha256)) {
    console.log(`[boot] fixtures already imported (${path.basename(file)}, sha256 ${sha256.slice(0, 12)}): not imported again, so what the organizers changed or removed stands`);
    return named;
  }
  const eventHere = (id: string | null) => id !== null && h.db.select({ id: events.id }).from(events).where(eq(events.id, id)).get() !== undefined;
  // A refused file stops the start only when the volume holds no event at all: then the portal has nothing to serve.
  // With any event here (the file's own, or others) the start logs the refusal and goes on with what is here.
  const volumeEmpty = () => h.db.select({ id: events.id }).from(events).limit(1).get() === undefined;
  const parsed = FixtureSchema.safeParse(raw);
  if (!parsed.success) {
    // Not the fixture format, or past a limit the forms keep (a label too long, too many questions)
    if (volumeEmpty()) throw new Error(`${whichFile(file)} is not a fixture file: ${firstProblem(parsed.error)}`);
    const here = eventHere(named);
    console.warn(
      `[boot] fixtures not imported from ${file} (sha256 ${sha256.slice(0, 12)}${here ? "" : `, for ${named ?? "an event"} not here yet`}): ${firstProblem(parsed.error)}: nothing from this file was imported; the portal starts with the data it has. Fix that row in the file; each start tries the file again.`,
    );
    return here ? named : null;
  }
  const fixture: Fixture = parsed.data;
  // The same guard as an uploaded import (dal/imports.ts): an event whose results are published is final, so a
  // changed file adds nothing to it. The import rolls back and the portal starts with the event as published.
  let published = false;
  let report: ReturnType<typeof importFixtures>;
  try {
    report = importFixtures(h.db, fixture, {
      source: path.basename(file),
      sha256,
      now,
      gate: (tx) => {
        published = Boolean(tx.select({ at: events.resultsPublishedAt }).from(events).where(eq(events.id, fixture.event.id)).get()?.at);
      },
      after: (_tx, r) => {
        if (published && Object.values(r.inserted).some((n) => n > 0)) throw new PublishedEventImport();
      },
    });
  } catch (err) {
    if (err instanceof PublishedEventImport) {
      console.warn(
        `[boot] fixtures not imported (${path.basename(file)}, sha256 ${sha256.slice(0, 12)}): the file adds to ${fixture.event.id}, whose results are published, so nothing was added. Give the file an event id of its own to import it as a new event.`,
      );
      return fixture.event.id;
    }
    // A changed file that the event here refuses (a team past its size, a second project for a team, a judge on the
    // team they review, a new criterion after scoring, a rubric past its limits, ids other events hold) is refused
    // whole, as an upload is. Stopping the start for it would loop the container (restart: unless-stopped) and keep
    // the portal down, so the start says why and goes on with the data it has. A file broken as a file (missing, not
    // JSON) still stops it, above; anything else (a database fault) still stops it too.
    if (!(err instanceof HttpError)) throw err;
    const details =
      err.details && typeof err.details === "object"
        ? Object.entries(err.details as Record<string, unknown>)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
            .join("; ")
        : "";
    const why = `${err.message.replace(/\s*Nothing was imported\.$/, "")} (rule ${err.code}${details ? `; ${details}` : ""})`;
    // A volume with no event at all (a fresh one): there is nothing to start with, so the start stops here with the
    // file, the row and the rule, as it does for a file past the format's limits above. Going on would start an empty
    // portal the operator did not ask for (or, with the demo sessions on, stop a step later on a reason that is not the
    // real one). A file for a new event on a volume that holds others is
    // logged below and the portal starts with those.
    if (volumeEmpty()) {
      throw new Error(
        `${whichFile(file)} cannot be imported (sha256 ${sha256.slice(0, 12)}): ${why}. Nothing from it was imported, and no event is here yet (${fixture.event.id} would be the first), so the portal has nothing to start with: fix the file or point FIXTURES_PATH at another.`,
      );
    }
    const here = eventHere(fixture.event.id);
    console.warn(
      `[boot] fixtures not imported from ${file} (sha256 ${sha256.slice(0, 12)}${here ? "" : `, for ${fixture.event.id} not here yet`}): ${why}: nothing from this file was imported; the portal starts with the data it has. ${here ? "Fix that row in the file, or change the event on its pages" : "Fix that row in the file"}; each start tries the file again.`,
    );
    return here ? fixture.event.id : null;
  }
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
  // before the database is opened: a portal others can reach never runs on the public default secret
  const refused = startRefusal();
  if (refused) throw new Error(`refusing to start: ${refused}`);
  const mailRefused = mailProblem();
  if (mailRefused) throw new Error(`refusing to start: ${mailRefused}`);
  const settingRefused = settingsProblem();
  if (settingRefused) throw new Error(`refusing to start: ${settingRefused}`);
  // one portal process per data volume (src/server/instance-lock.ts)
  const dbFile = databasePath();
  if (dbFile !== ":memory:") {
    const busy = claimDataFolder(path.dirname(dbFile));
    if (busy) throw new Error(`refusing to start: ${busy}`);
  }
  const h = handle();
  const triggers = runMigrations(h);
  if (triggers.restored.length > 0) console.warn(`[boot] triggers restored: ${triggers.restored.join(", ")}`);

  const now = nowIso();
  const eventId = bootFixture(h, now);
  const swept = sweepOrphanUploads(h.db);
  if (swept.skipped) console.warn(`[boot] uploads: ${swept.kept} stored pictures, and ${swept.skipped}`);
  else if (swept.removed) console.log(`[boot] uploads: removed ${swept.removed} stored ${swept.removed === 1 ? "picture" : "pictures"} no project names (${swept.kept} kept)`);
  const key = ensureSigningKey(h.db, now);
  console.log(`[boot] records are signed with Ed25519 key ${key.id}; public key at /.well-known/dogfood-keys.json`);

  const base = process.env.PUBLIC_URL ?? "http://localhost:8080";
  const event = eventId ? requireEvent(h.db, eventId) : null;
  const lines: string[] = [];
  if (checkerSessionsEnabled() && !event && fixturesPath() !== "none") {
    // The file's new event was refused (its reason is logged above) on a volume that holds other events: the portal
    // starts with those, and demo mode has no fixture event for its sessions this start. Sessions an earlier start
    // seeded are left as they were; each start tries the file again.
    console.warn(
      `[boot] WARNING: no checker sessions this start: SEED_CHECKER_SESSIONS=true needs the fixture event, and the fixture file's event is not here (its import was refused, above); the portal starts with the events it has, and the acceptance checks that need the sessions fail until the file imports`,
    );
  } else if (checkerSessionsEnabled()) {
    // bootFixture returns an event that is here, or null for FIXTURES_PATH=none or a refused file (above)
    if (!eventId || !event) {
      throw new Error("SEED_CHECKER_SESSIONS=true needs the fixture event, and FIXTURES_PATH=none starts without it: set FIXTURES_PATH to a fixture file, or turn the flag off");
    }
    ensureDemoOrganizer(h.db, eventId, now);
    const seeded = seedCheckerSessions(h.db, eventId, now);
    if (seeded.enabled) {
      const written = writeCheckerFile(path.dirname(databasePath()), checkerToml(seeded.identities, event));
      lines.push("seeded. test logins:");
      for (const i of seeded.identities) lines.push(`  ${i.label.padEnd(12)} Cookie: session=${i.token}`);
      lines.push(`  (who: ${seeded.identities.map((i) => `${i.label} = ${i.name}`).join(", ")})`);
      lines.push(`  the [auth] and [routes] blocks for .dogfood.toml are in ${written}`);
      if (seeded.skipped.length) {
        // The organizers removed judges or changed their tracks since the fixture: the portal starts anyway.
        const it = seeded.skipped.length === 1 ? "it" : "them";
        console.warn(
          `[boot] WARNING: no checker session for ${seeded.skipped.map((s) => `${s.label} (${s.why})`).join(", ")}; the portal starts without ${it}, and the acceptance checks that need ${it} fail until a fitting judge exists (each start picks again)`,
        );
      }
    }
    const vote = seedDemoVote(h.db, eventId, now);
    if (vote.code && vote.closesAt && Date.parse(vote.closesAt) > Date.now()) {
      lines.push(`community vote (demo): open until ${vote.closesAt.slice(0, 16).replace("T", " ")} UTC; sign in, or use the open link ${base}/vote/${vote.code}`);
    }
  } else {
    const seeded = seedCheckerSessions(h.db, eventId ?? "", now);
    const refusal = demoModeRefusal();
    lines.push(
      `${refusal ? `checker sessions REFUSED: ${refusal}; for a real event, set SEED_CHECKER_SESSIONS=false` : `checker sessions are OFF (SEED_CHECKER_SESSIONS is not "true")`}${!seeded.enabled && seeded.removed ? `; removed ${seeded.removed} left from an earlier boot` : ""}${!seeded.enabled && seeded.signedOut ? `; signed out ${seeded.signedOut} demo sign-in ${seeded.signedOut === 1 ? "session" : "sessions"}` : ""}${!seeded.enabled && seeded.demoted ? "; the demo organizer is no longer an administrator" : ""}${!seeded.enabled ? demoGrantsLine(seeded.revoked) : ""}.`,
    );
  }
  const setup = openAdminSetup(h.db);
  if (setup) {
    lines.push(`administrator setup: open ${base}/sign-up?setup=${setup.code}`);
    lines.push(`  and sign up as ${setup.waiting.join(" or ")} (only this link makes an administrator; it works once, and each start prints a new one while a named address has no account)`);
  }
  startWebhookWorker();
  console.log(lines.join("\n"));
  announceWhenWarm(event, event ? `${base}/events/${event.slug}` : `${base}/sign-up`, Date.now() - started);
}

/**
 * The "portal ready" line comes after the warm-up (src/server/warmup.ts): the portal has then answered the gallery
 * and the routes the acceptance checker asks first once, so their first real request is a warm one. Not awaited:
 * the warm-up's requests are served like any other, which needs register() to have returned.
 */
function announceWhenWarm(event: { id: string; slug: string } | null, url: string, bootMs: number): void {
  const warmStarted = Date.now();
  void warmUp(selfBase(), warmUpSteps(event), (results) => {
    // /api/health answers 503 until the warm-up is done, by design
    const failed = results.filter((r) => r.status === null || (r.status >= 500 && !(r.path === "/api/health" && r.status === 503)));
    if (failed.length) {
      console.warn(
        `[boot] warm-up: ${failed.map((r) => `${r.method} ${r.path} ${r.status === null ? "did not answer" : `answered ${r.status}`}`).join(", ")}; the first real request there may be slow`,
      );
    }
    const first = results[0];
    const firstPart = first && first.status !== null ? `, first ${first.path} ${first.ms} ms` : "";
    console.log(`portal ready: ${url}  (boot took ${bootMs} ms, warm-up ${Date.now() - warmStarted} ms${firstPart})`);
  });
}

/**
 * Exit instead of serving 500s from a half-seeded database: `docker compose up`
 * then shows the crash and its reason (the restart policy tries again, with a
 * growing delay, so the reason keeps showing until it is fixed).
 */
export async function bootOrExit(): Promise<void> {
  try {
    await boot();
  } catch (err) {
    console.error("[boot] failed, exiting:", err);
    process.exit(1);
  }
}
