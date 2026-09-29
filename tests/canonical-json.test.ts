import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { publishResults } from "@/server/dal/results";
import { getRecord, issueOwnRecord, keysDocument } from "@/server/dal/records";
import { ensureSigningKey, signRecord } from "@/server/signing";
import { canonicalJson as shared } from "@/lib/canonical-json";
import { canonicalJson as server } from "@/server/util";
import { checkInBrowser } from "@/app/records/[record]/check";
import type { Actor } from "@/server/authz";

// One canonical JSON (src/lib/canonical-json.ts): the server hashes and signs with it, and the record page's check in
// the browser imports the same function. scripts/verify-record.mjs runs on Node's built-ins alone and keeps a copy; this
// test feeds the same records through it (its --canonical flag prints the bytes it would verify) and demands identical
// bytes: the records the portal issues, every audit row's hashed fields, and hand-made values at the edges of JSON.
// The instrument is shown to see a difference: the string-building copy the script had before is caught on the corpus.

const NOW = "2026-09-26T12:00:00.000Z";
const SCRIPT = path.join(process.cwd(), "scripts", "verify-record.mjs");
let h: Handle;
let dir: string;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-json-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setHandleForTests(null);
  h.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}

/** Publish the fixture event (its three decisions settled, as records.test.ts does) and issue a judge's and a member's record. */
function issuedRecords(): Record<string, unknown>[] {
  const org = actorById("usr_organizer");
  setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  publishResults(org, "evt_01");
  const judge = (h.sqlite.prepare("SELECT judge_user_id AS id FROM assignments WHERE status = 'done' AND judge_user_id <> 'jdg_07' LIMIT 1").get() as { id: string }).id;
  const member = (
    h.sqlite
      .prepare("SELECT tm.user_id AS id FROM team_members tm JOIN projects p ON p.team_id = tm.team_id WHERE p.status = 'submitted' AND p.duplicate_of IS NULL AND tm.event_id = 'evt_01' LIMIT 1")
      .get() as { id: string }
  ).id;
  return [issueOwnRecord(actorById(judge), "evt_01", "judge"), issueOwnRecord(actorById(member), "evt_01", "participant")].map((r) => getRecord(r.id).envelope.record);
}

/** Each audit row's hashed fields as one object (src/server/audit.ts auditPayload), as its bytes are made. */
function auditObjects(): Record<string, unknown>[] {
  return h.db
    .select()
    .from(auditLog)
    .orderBy(auditLog.id)
    .all()
    .map((r) => ({
      at: r.at,
      actorUserId: r.actorUserId,
      actorLabel: r.actorLabel,
      action: r.action,
      eventId: r.eventId,
      targetType: r.targetType,
      targetId: r.targetId,
      before: r.before,
      after: r.after,
      ...(r.salt ? { salt: r.salt } : {}),
    }));
}

/** Values at the edges of JSON: keys that are array indices, keys that sort before digits, escapes, astral and lone surrogates, numbers. */
const EDGES: Record<string, unknown>[] = [
  { 2: "b", 10: "a", a: 1 }, // index keys: written first, by number
  { 1: 1, "-x": 2, "01": 3, "1a": 4, " ": 5 }, // keys that sort before "1" but are not indices
  { values: { 1: 3, 2: 4, 10: 5 }, "4294967294": "last index", "4294967295": "not an index" },
  { z: [{ b: 1, a: [{ d: 4, c: 3 }] }, [], {}], a: null, m: [3, 1, 2] },
  { quote: 'say "hi"', slash: "a\\b/c", control: "\u0000\u0007\n\t\u001f", separators: "  ", astral: "😀𝄞", lone: "\ud800x\udc00", accents: "Ärger, ñandú" },
  { "é": 1, e: 2, "😀": 3, "￿": 4, E: 5 }, // UTF-16 code unit order: "😀" (d83d) before "￿"
  { n: [0, -0, 1.5, -2.25, 1e21, 1e-7, 123456789012345680000, Number.MAX_SAFE_INTEGER, 0.1 + 0.2], t: true, f: false },
  { ["__proto__"]: { polluted: false }, constructor: "c", toString: "s" },
];

/** The script's bytes for a record: its --canonical output, read from a file as a verifier reads a download. */
function scriptBytes(record: Record<string, unknown>, name: string): string {
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ record, signature: "unused" }));
  const run = spawnSync(process.execPath, [SCRIPT, file, "--canonical"], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

/** The copy the script held before this test existed: string building in sorted order. */
function stringBuilt(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stringBuilt).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stringBuilt((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("one canonical JSON for hashes and signatures", () => {
  it("the server's function is the shared one, which the browser's check imports", () => {
    expect(server).toBe(shared);
    const source = fs.readFileSync(path.join(process.cwd(), "src", "app", "records", "[record]", "check.tsx"), "utf8");
    expect(source).toContain('import { canonicalJson } from "@/lib/canonical-json"');
    expect(source).not.toMatch(/\.sort\(\)/); // no copy of its own
  });

  it("the standalone script gives the same bytes for every record, audit row and edge value, before and after a JSON round trip", () => {
    // each issued record as it is, then every audit row and every edge value in one record each: an array is written
    // element by element, so equal bytes for the whole are equal bytes for each (one script run each, not hundreds)
    const records = issuedRecords();
    const audit = auditObjects();
    expect(audit.length).toBeGreaterThan(5); // the import, the decisions, the publish, the records
    const bundles: Record<string, unknown>[] = [...records, { rows: audit }, { edges: EDGES.map((e) => structuredClone(e)) }];
    bundles.forEach((value, i) => {
      const bytes = shared(value);
      expect(scriptBytes(value, `v${i}`), `bundle ${i}: ${bytes.slice(0, 80)}`).toBe(bytes);
      expect(shared(JSON.parse(JSON.stringify(value)))).toBe(bytes);
    });
  });

  it("the order is the one DATA-MODEL.md states: index keys first by number, then the rest sorted", () => {
    expect(shared(EDGES[0])).toBe('{"2":"b","10":"a","a":1}');
    expect(shared({ b: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }] })).toBe('{"a":[{"x":2,"y":1}],"b":{"c":2,"d":1}}');
  });

  it("known-bad: the instrument sees a copy that differs (the script's old string building, on index keys)", () => {
    const differs = EDGES.filter((e) => stringBuilt(e) !== shared(e));
    expect(differs.length).toBeGreaterThan(0);
    // and it matters: a record signed by the portal with such keys failed the old copy's check
    expect(stringBuilt({ 2: "b", 10: "a" })).not.toBe(shared({ 2: "b", 10: "a" }));
  });

  it("a record signed by the portal, index keys and all, is valid in the browser's check and the script's, and a tampered one in neither", async () => {
    const key = ensureSigningKey(h.db, NOW);
    const record = { ...structuredClone(EDGES[2]!), format: "test", id: "rec_edge", issuer: "http://localhost:8080", keyId: key.id };
    const envelope = signRecord(key, record);
    const keys = keysDocument();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(keys)));
    expect(await checkInBrowser(envelope)).toEqual({ at: "valid", kid: key.id });

    const keysFile = path.join(dir, "keys.json");
    fs.writeFileSync(keysFile, JSON.stringify(keys));
    const verify = (env: unknown) => {
      const file = path.join(dir, "signed.json");
      fs.writeFileSync(file, JSON.stringify(env));
      return spawnSync(process.execPath, [SCRIPT, file, "--keys", keysFile], { encoding: "utf8" });
    };
    const good = verify(envelope);
    expect(good.status, good.stdout + good.stderr).toBe(0);
    expect(good.stdout).toContain("VALID");

    const tampered = { ...envelope, record: { ...envelope.record, values: { 1: 3, 2: 4, 10: 1 } } };
    expect((await checkInBrowser(tampered)).at).toBe("invalid");
    expect(verify(tampered).status).toBe(1);
  });

  it("the portal's own records verify in the browser's check", async () => {
    const [judgeRecord] = issuedRecords();
    const { envelope } = getRecord(String(judgeRecord!.id));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(keysDocument())));
    expect((await checkInBrowser(envelope)).at).toBe("valid");
  });
});
