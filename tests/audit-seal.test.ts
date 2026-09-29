import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles, webhookDeliveries } from "@/server/db/schema";
import { appendAudit, chainHash, GENESIS_HASH, verifyAuditChain } from "@/server/audit";
import { sealsValues } from "@/server/webhooks";
import { ensureDemoOrganizer } from "@/server/checker";
import { resetRateLimits } from "@/server/rate-limit";
import { castBallot, enterVoting } from "@/server/dal/voting";
import { makeVotingLink, saveVotingSettings } from "@/server/dal/voting-organizer";
import { saveReview } from "@/server/dal/reviews";
import { getPairwiseState, pickPairwise, setJudgingMode } from "@/server/dal/pairwise";
import { hideComment, postComment } from "@/server/dal/comments";
import { createWebhook } from "@/server/dal/webhooks";
import { auditCsv, getAuditLog } from "@/server/dal/audit-log";
import type { Actor } from "@/server/authz";

// A row's hash covers its values, and every other field of the row is visible to someone: a webhook receiver sees
// the time, actor, action, event and target, and audit.csv gives the hash of the row before. Before the salt, hashing
// every candidate found a ballot's three picks among 40 projects (7,075 guesses) and a review's three scores (32
// guesses) on main, from exactly what these tests give the attacker. Each attack below also runs with the row's salt
// as its positive control: it then finds the values, so the attacker is sound and the salt alone stops it.

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;
let savedAllowPrivate: string | undefined;

beforeEach(() => {
  resetRateLimits();
  savedAllowPrivate = process.env.WEBHOOKS_ALLOW_PRIVATE;
  process.env.WEBHOOKS_ALLOW_PRIVATE = "true"; // the test hook points at 127.0.0.1; nothing is ever sent
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
});

afterEach(() => {
  if (savedAllowPrivate === undefined) delete process.env.WEBHOOKS_ALLOW_PRIVATE;
  else process.env.WEBHOOKS_ALLOW_PRIVATE = savedAllowPrivate;
  setHandleForTests(null);
  h.sqlite.close();
});

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}
const organizer = () => actorById("usr_organizer");
let ipSeq = 0;
function linkToken(): string {
  const { code } = makeVotingLink(organizer(), "evt_01");
  return enterVoting(code, { ip: `10.77.0.${++ipSeq}`, agent: "Agent" }).token;
}
const openVoting = () =>
  saveVotingSettings(organizer(), "evt_01", { votingOpenAt: "2026-01-01T00:00", votingCloseAt: "2999-01-01T00:00", modes: ["link"], votesPerVoter: "3", countLink: true });
const closeVoting = () => h.sqlite.prepare("UPDATE events SET voting_close_at = '2026-01-02T00:00:00.000Z' WHERE id = 'evt_01'").run();
const hook = (actions: string[]) => createWebhook(organizer(), "evt_01", { url: "http://127.0.0.1:9/hook", actions });

// --- the attacker and the verifier: only the published payload format (DATA-MODEL.md) and what a reader sees ---

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]))
        : x;
  return JSON.stringify(sort(v));
}
type Seen = { at: string; actorUserId: string | null; actorLabel: string; action: string; eventId: string | null; targetType: string | null; targetId: string | null };
type Guess = { before: unknown; after: unknown; targetId?: string | null };

/** Hash every candidate the way the row's hash is made; the one that matches is what the row holds. */
function bruteForce(seen: Seen, prevHash: string, hash: string, guesses: Iterable<Guess>, salt?: string | null): { guess: Guess; tried: number } | { guess: null; tried: number } {
  let tried = 0;
  for (const g of guesses) {
    tried++;
    const payload = { ...seen, targetId: g.targetId === undefined ? seen.targetId : g.targetId, before: g.before ?? null, after: g.after ?? null, ...(salt ? { salt } : {}) };
    if (sha(`${prevHash}\n${canonical(payload)}`) === hash) return { guess: g, tried };
  }
  return { guess: null, tried };
}

/** What a webhook receiver sees of a row: everything but the sealed values. */
function seenInHook(auditId: number): { seen: Seen; hash: string; body: string; data: Record<string, unknown> } {
  const d = h.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.auditId, auditId)).get();
  if (!d) throw new Error(`no delivery for audit row ${auditId}`);
  const p = d.payload as { type: string; event: { id: string }; data: { at: string; actor: { userId: string | null; label: string }; target: { type: string | null; id: string | null }; hash: string } };
  return {
    seen: { at: p.data.at, actorUserId: p.data.actor.userId, actorLabel: p.data.actor.label, action: p.type, eventId: p.event.id, targetType: p.data.target.type, targetId: p.data.target.id },
    hash: p.data.hash,
    body: JSON.stringify(p),
    data: p.data as unknown as Record<string, unknown>,
  };
}

/** audit.csv as rows keyed by its header (RFC 4180). */
function csvRows(): Record<string, string>[] {
  const text = auditCsv(h.db, "evt_01");
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      records.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  const [header, ...rest] = records;
  return rest.map((r) => Object.fromEntries(header!.map((k, i) => [k, r[i] ?? ""])));
}
const csvRow = (id: number) => csvRows().find((r) => r.id === String(id))!;

const HIDDEN = "hidden until voting closes";

/** A verifier holding only one line of audit.csv: the row's hash as recomputed from that line's own cells; null while they are hidden. */
function recompute(line: Record<string, string>): string | null {
  if ([line.before, line.after, line.salt].includes(HIDDEN)) return null;
  const json = (s: string) => (s === "" ? null : JSON.parse(s));
  const payload = {
    at: line.at,
    actorUserId: line.actor_user_id || null,
    actorLabel: line.actor,
    action: line.action,
    eventId: line.event_id || null,
    targetType: line.target_type || null,
    targetId: line.target_id || null,
    before: json(line.before!),
    after: json(line.after!),
    ...(line.salt ? { salt: line.salt } : {}),
  };
  return sha(`${line.prev_hash}\n${canonical(payload)}`);
}

const rowsOf = (action: string) => h.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(auditLog.id).all();
const ballotProjects = () =>
  (h.sqlite.prepare("SELECT id FROM projects WHERE event_id = 'evt_01' AND status = 'submitted' AND duplicate_of IS NULL ORDER BY id").all() as { id: string }[]).map((r) => r.id);

/** Every ballot of up to three picks, in every order, as a first ballot (nothing picked before). */
function* ballots(ids: string[]): Generator<Guess> {
  yield { before: { picks: [] }, after: { picks: [] } };
  for (const a of ids) {
    yield { before: { picks: [] }, after: { picks: [a] } };
    for (const b of ids) {
      if (b === a) continue;
      yield { before: { picks: [] }, after: { picks: [a, b] } };
      for (const c of ids) if (c !== a && c !== b) yield { before: { picks: [] }, after: { picks: [a, b, c] } };
    }
  }
}

describe("a row with sealed values: its hash gives them away to nobody", () => {
  it("a ballot: brute force over every ballot fails while voting is open; once it closes, audit.csv shows the salt and the row recomputes", async () => {
    await hook(["vote.cast"]);
    openVoting();
    const ids = ballotProjects();
    const picks = [ids[4]!, ids[17]!, ids[29]!];
    castBallot(null, "evt_01", linkToken(), { projectIds: picks }, { ip: "10.0.0.5", agent: "VoterBrowser" });

    const row = rowsOf("vote.cast").at(-1)!;
    expect(row.salt).toMatch(/^[0-9a-f]{64}$/);
    const { seen, hash, body } = seenInHook(row.id);
    expect(body).not.toContain(picks[0]);
    expect(body).not.toContain(row.salt!); // the salt never goes out
    const open = csvRow(row.id);
    expect([open.before, open.after, open.salt]).toEqual([HIDDEN, HIDDEN, HIDDEN]);
    expect(open.prev_hash).toBe(row.prevHash);

    const blind = bruteForce(seen, open.prev_hash!, hash, ballots(ids));
    expect(blind.guess).toBeNull();
    expect(blind.tried).toBeGreaterThan(59_000); // every ordered ballot of up to three of the event's projects
    // positive control: the same attacker holding the salt finds the picks, so it is the salt that stops it
    expect(bruteForce(seen, open.prev_hash!, hash, ballots(ids), row.salt).guess?.after).toEqual({ picks });

    closeVoting();
    const closed = csvRow(row.id);
    expect(closed.salt).toBe(row.salt);
    expect(JSON.parse(closed.after!)).toEqual({ picks });
    expect(recompute(closed)).toBe(row.hash);
    expect(recompute(open)).toBeNull(); // with the values hidden the line cannot be recomputed, by design
  });

  it("a judge's scores: the webhook says who scored which project; the values cannot be brute-forced from its hash", async () => {
    await hook(["review.save"]);
    const a = h.sqlite.prepare("SELECT id, judge_user_id AS judge FROM assignments WHERE event_id = 'evt_01' AND status = 'done' ORDER BY id LIMIT 1").get() as { id: string; judge: string };
    const criteria = h.sqlite.prepare("SELECT key, scale_min AS min, scale_max AS max FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY key").all() as { key: string; min: number; max: number }[];
    const stored = h.sqlite.prepare("SELECT c.key, si.value FROM score_items si JOIN scores s ON s.id = si.score_id JOIN rubric_criteria c ON c.id = si.criterion_id WHERE s.assignment_id = ?").all(a.id) as { key: string; value: number }[];
    const values = Object.fromEntries(stored.map((s) => [s.key, s.value]));
    saveReview(actorById(a.judge), a.id, { values: Object.fromEntries(criteria.map((c) => [c.key, null])) });

    const row = rowsOf("review.save").at(-1)!;
    const { seen, hash, body, data } = seenInHook(row.id);
    expect(body).not.toContain(row.salt!);
    const project = (data.after as { project: string }).project;
    function* scoreGuesses(): Generator<Guess> {
      const vectors = (i: number): Record<string, number>[] =>
        i === criteria.length ? [{}] : vectors(i + 1).flatMap((rest) => Array.from({ length: criteria[i]!.max - criteria[i]!.min + 1 }, (_, v) => ({ [criteria[i]!.key]: criteria[i]!.min + v, ...rest })));
      for (const before of vectors(0)) yield { before, after: { ...Object.fromEntries(criteria.map((c) => [c.key, null])), project } };
    }
    const prev = csvRow(row.id).prev_hash!;
    const blind = bruteForce(seen, prev, hash, scoreGuesses());
    expect(blind.guess).toBeNull();
    expect(blind.tried).toBe(criteria.reduce((n, c) => n * (c.max - c.min + 1), 1));
    expect(bruteForce(seen, prev, hash, scoreGuesses(), row.salt).guess?.before).toEqual(values); // positive control
    // the organizer reads a review's values in the log anyway, so audit.csv shows its salt from the start
    const line = csvRow(row.id);
    expect(line.salt).toBe(row.salt);
    expect(recompute(line)).toBe(row.hash);
  });

  it("a pairwise answer: the webhook carries the track only; neither the answer nor its projects can be brute-forced", async () => {
    await hook(["pairwise.pick"]);
    setJudgingMode(organizer(), "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
    const judges = (h.sqlite.prepare("SELECT user_id AS id FROM user_roles WHERE event_id = 'evt_01' AND role = 'judge' ORDER BY user_id").all() as { id: string }[]).map((j) => actorById(j.id));
    const judge = judges.find((j) => getPairwiseState(j, "evt_01").tracks.some((t) => t.current))!;
    const t = getPairwiseState(judge, "evt_01").tracks.find((x) => x.current)!;
    pickPairwise(judge, "evt_01", { trackId: t.trackId, left: t.current!.left.id, right: t.current!.right.id, outcome: "right" });

    const row = rowsOf("pairwise.pick").at(-1)!;
    const { seen, hash, body, data } = seenInHook(row.id);
    expect(body).not.toContain(row.salt!);
    const trackId = (data.after as { trackId: string }).trackId;
    const inTrack = (h.sqlite.prepare("SELECT id FROM projects WHERE event_id = 'evt_01' AND track_id = ? ORDER BY id").all(trackId) as { id: string }[]).map((r) => r.id);
    function* answers(): Generator<Guess> {
      for (const left of inTrack)
        for (const right of inTrack)
          if (left !== right)
            for (const outcome of ["left", "right", "tie"])
              for (const targetId of [left, right]) yield { before: null, after: { trackId, left, right, outcome }, targetId };
    }
    const prev = csvRow(row.id).prev_hash!;
    expect(bruteForce(seen, prev, hash, answers()).guess).toBeNull();
    expect(bruteForce(seen, prev, hash, answers(), row.salt).guess?.after).toMatchObject({ outcome: "right", left: t.current!.left.id }); // positive control
  });

  it("exactly the actions a webhook seals get a salt, in its format; no delivery body carries one", async () => {
    await hook(["*"]);
    openVoting();
    castBallot(null, "evt_01", linkToken(), { projectIds: [ballotProjects()[0]!] }, { ip: "10.0.0.5", agent: "VoterBrowser" });
    const a = h.sqlite.prepare("SELECT id, judge_user_id AS judge FROM assignments WHERE event_id = 'evt_01' AND status = 'done' ORDER BY id LIMIT 1").get() as { id: string; judge: string };
    saveReview(actorById(a.judge), a.id, { feedback: "A clear demo; the README could say how to run it." });
    const { id: commentId } = postComment(organizer(), ballotProjects()[1]!, { body: "Nice work" });
    hideComment(organizer(), commentId, { reason: "testing the salt rule" });

    const rows = h.db.select().from(auditLog).orderBy(auditLog.id).all();
    const salted = rows.filter((r) => r.salt !== null).map((r) => r.action);
    // known-bad guard: the rule has rows on both sides to decide
    expect(new Set(salted)).toEqual(new Set(["fixtures.import", "vote.cast", "review.amend"])); // a feedback edit on a finished review
    expect(rows.some((r) => r.salt === null && ["voting.settings", "comment.post", "comment.hide", "webhook.create"].includes(r.action))).toBe(true);
    for (const r of rows) {
      expect(r.salt !== null, r.action).toBe(sealsValues(r.action));
      if (r.salt) expect(r.salt).toMatch(/^[0-9a-f]{64}$/);
    }
    const bodies = JSON.stringify(h.db.select({ p: webhookDeliveries.payload }).from(webhookDeliveries).all());
    expect(bodies).toContain("vote.cast"); // positive control: the sealed rows did go out
    for (const r of rows) if (r.salt) expect(bodies).not.toContain(r.salt);
    // the page's and the CSV's chain check still verify every row
    expect(verifyAuditChain(h.db).ok).toBe(true);
    expect(getAuditLog(organizer(), "evt_01").chain.ok).toBe(true);
    expect(new Set(csvRows().map((l) => l.chain_ok))).toEqual(new Set(["yes"]));
  });

  it("every line of audit.csv recomputes from its own cells, except a ballot's while voting is open", async () => {
    openVoting();
    castBallot(null, "evt_01", linkToken(), { projectIds: [ballotProjects()[2]!, ballotProjects()[3]!] }, { ip: "10.0.0.5", agent: "VoterBrowser" });
    const a = h.sqlite.prepare("SELECT id, judge_user_id AS judge FROM assignments WHERE event_id = 'evt_01' AND status = 'done' ORDER BY id LIMIT 1").get() as { id: string; judge: string };
    saveReview(actorById(a.judge), a.id, { feedback: "Said with \"quotes\", commas, and a line\nbreak." });
    const failing = () => csvRows().filter((l) => recompute(l) !== l.hash).map((l) => l.action);
    expect(csvRows().length).toBeGreaterThan(5);
    expect(failing()).toEqual(["vote.cast"]);
    closeVoting();
    expect(failing()).toEqual([]);
  });
});

describe("the chain a portal already holds", () => {
  // Hashes the code before the salt made (main at 39b21d3), for these exact rows: a row without a salt hashes the same.
  const plain = { at: "2026-09-20T10:00:00.000Z", actorUserId: "usr_organizer", actorLabel: "Olga Organizer", action: "comment.hide", eventId: "evt_01", targetType: "project", targetId: "prj_07", before: null, after: { reason: "spam" } };
  const oldBallot = { at: "2026-09-20T10:01:00.000Z", actorUserId: null, actorLabel: "Link voter abc123", action: "vote.cast", eventId: "evt_01", targetType: "voter", targetId: "vtr_abc123", before: { picks: [] }, after: { picks: ["prj_05", "prj_18", "prj_30"] } };
  const H1 = "01cd89eecbbeac211dbbffc6c06027fc79fbd791bf79fccae5b3808e47f897c3";
  const H2 = "6ad7685d394980030baebfa90c2ef1877af3b764b4f4e95d9586415d2fac8c98";

  it("rows written before salts existed hash as they always did; a salt changes the hash", () => {
    expect(chainHash(GENESIS_HASH, plain)).toBe(H1);
    expect(chainHash(H1, oldBallot)).toBe(H2);
    expect(chainHash(H1, { ...oldBallot, salt: null })).toBe(H2);
    expect(chainHash(H1, { ...oldBallot, salt: "ab".repeat(32) })).not.toBe(H2);
  });

  it("a database from before the migration keeps a valid chain through it, its triggers hold, and new sealed rows are salted", () => {
    // the migrations up to 0013 alone, as a portal running the old code has them
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-mig-"));
    try {
      const src = path.join(process.cwd(), "drizzle");
      const journal = JSON.parse(fs.readFileSync(path.join(src, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
      journal.entries = journal.entries.filter((e) => e.idx <= 13);
      expect(journal.entries.at(-1)!.tag).toBe("0013_project_fields");
      fs.mkdirSync(path.join(dir, "meta"));
      fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal));
      for (const e of journal.entries) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));

      const old = openDatabase(":memory:");
      try {
        runMigrations(old, dir);
        const cols = () => (old.sqlite.prepare("PRAGMA table_info(audit_log)").all() as { name: string }[]).map((c) => c.name);
        expect(cols()).not.toContain("salt");
        // the rows the old code wrote, with its hashes
        const insert = old.sqlite.prepare(
          "INSERT INTO audit_log (at, actor_user_id, actor_label, action, event_id, target_type, target_id, before, after, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const json = (v: unknown) => (v === null ? null : JSON.stringify(v));
        insert.run(plain.at, plain.actorUserId, plain.actorLabel, plain.action, plain.eventId, plain.targetType, plain.targetId, json(plain.before), json(plain.after), GENESIS_HASH, H1);
        insert.run(oldBallot.at, oldBallot.actorUserId, oldBallot.actorLabel, oldBallot.action, oldBallot.eventId, oldBallot.targetType, oldBallot.targetId, json(oldBallot.before), json(oldBallot.after), H1, H2);

        runMigrations(old, path.join(process.cwd(), "drizzle")); // the boot after the upgrade
        expect(cols()).toContain("salt");
        expect(old.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE salt IS NULL").get()).toEqual({ n: 2 });
        expect(verifyAuditChain(old.db)).toEqual({ ok: true, rows: 2, head: H2 });

        const { at: _at, ...ballotEntry } = oldBallot;
        appendAudit(old.db, ballotEntry, "2026-09-29T01:00:00.000Z");
        const added = old.sqlite.prepare("SELECT salt, prev_hash AS prev FROM audit_log ORDER BY id DESC LIMIT 1").get() as { salt: string; prev: string };
        expect(added.prev).toBe(H2);
        expect(added.salt).toMatch(/^[0-9a-f]{64}$/);
        expect(verifyAuditChain(old.db).ok).toBe(true);

        // still append-only after the ALTER, and the column refuses a salt that is not 32 bytes of hex
        expect(() => old.sqlite.prepare("UPDATE audit_log SET salt = NULL").run()).toThrow(/append-only/);
        expect(() => old.sqlite.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
        const withSalt = (salt: string) =>
          old.sqlite
            .prepare("INSERT INTO audit_log (at, actor_label, action, prev_hash, hash, salt) VALUES ('2026-09-29T02:00:00.000Z', 'x', 'x', ?, ?, ?)")
            .run(GENESIS_HASH, sha(salt), salt);
        expect(() => withSalt("not-hex")).toThrow(/CHECK constraint failed/);
        expect(() => withSalt("AB".repeat(32))).toThrow(/CHECK constraint failed/); // lowercase hex only
        expect(() => withSalt("ab".repeat(32))).not.toThrow(); // positive control
      } finally {
        old.sqlite.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the salt is bound into the hash: taking it off a row, or putting one on an old row, breaks the chain there", () => {
    openVoting();
    castBallot(null, "evt_01", linkToken(), { projectIds: [ballotProjects()[0]!] }, { ip: "10.0.0.5", agent: "VoterBrowser" });
    const row = rowsOf("vote.cast").at(-1)!;
    const plainRow = rowsOf("voting.settings").at(-1)!;
    expect(verifyAuditChain(h.db).ok).toBe(true); // positive control
    // someone holding the file, past the triggers
    h.sqlite.exec("DROP TRIGGER audit_log_no_update");
    h.sqlite.prepare("UPDATE audit_log SET salt = NULL WHERE id = ?").run(row.id);
    expect(verifyAuditChain(h.db)).toMatchObject({ ok: false, brokenAtId: row.id });
    h.sqlite.prepare("UPDATE audit_log SET salt = ? WHERE id = ?").run(row.salt, row.id);
    expect(verifyAuditChain(h.db).ok).toBe(true);
    h.sqlite.prepare("UPDATE audit_log SET salt = ? WHERE id = ?").run("0".repeat(64), plainRow.id);
    expect(verifyAuditChain(h.db)).toMatchObject({ ok: false, brokenAtId: plainRow.id });
  });
});
