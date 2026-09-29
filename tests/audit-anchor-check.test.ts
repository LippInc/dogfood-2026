import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { ensureDemoOrganizer } from "@/server/checker";

// "Check a head you saved": the log page and audit.csv tell an organizer to keep the head hash with its row number,
// so the portal has to let them check that pair later, whichever row it is (a sign-in belongs to no event). The
// answer is only holds or not (anchorHolds), for the event's organizers: GET /api/events/{event}/audit/anchor and
// the form on the audit page, both through checkSavedHead in the data access layer.

const jar = { cookie: undefined as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: (name: string) => (name === "session" && jar.cookie ? { name, value: jar.cookie } : undefined), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { GET } = await import("@/app/api/events/[event]/audit/anchor/route");
const { createLoginSession } = await import("@/server/session");
const { appendAudit, chainHead, verifyAuditChain } = await import("@/server/audit");
const { keepHeadText } = await import("@/components/audit-chain");

const NOW = "2026-09-29T10:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
  jar.cookie = undefined;
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

const signIn = (userId: string | null) => {
  jar.cookie = userId ? createLoginSession(h.db, userId).token : undefined;
};
const judgeId = () => (h.sqlite.prepare("SELECT user_id AS id FROM user_roles WHERE role = 'judge' AND event_id = 'evt_01' LIMIT 1").get() as { id: string }).id;
const refusals = () => (h.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'authz.refused'").get() as { n: number }).n;
const lastId = () => (h.sqlite.prepare("SELECT max(id) AS id FROM audit_log").get() as { id: number }).id;

async function check(entry: string | number, hash: string, event = "evt_01") {
  const url = `http://localhost:8080/api/events/${event}/audit/anchor?entry=${encodeURIComponent(String(entry))}&hash=${encodeURIComponent(hash)}`;
  const res = await GET(new Request(url), { params: Promise.resolve({ event }) });
  return { status: res.status, body: (await res.json()) as { entry?: number; hash?: string; holds?: boolean; error?: string; details?: Record<string, string[]> } };
}

/** A head saved at a row no event owns (a sign-in), as the log page's "Keep this hash with its row" asks. */
function savePortalHead() {
  appendAudit(h.db, { actorUserId: null, actorLabel: "system", action: "auth.sign_in" }, NOW);
  const head = chainHead(h.db)!;
  expect(h.sqlite.prepare("SELECT event_id AS e FROM audit_log WHERE id = ?").get(head.entry)).toEqual({ e: null });
  return head;
}

/** Someone holding the file cuts from row `from` to the end, lowers SQLite's count so the check sees no gap, and the app writes on. */
function cutFromAndWriteOn(from: number, more: number) {
  h.sqlite.exec("DROP TRIGGER audit_log_no_delete");
  h.sqlite.prepare("DELETE FROM audit_log WHERE id >= ?").run(from);
  h.sqlite.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'audit_log'").run(from - 1);
  for (let i = 0; i < more; i++) appendAudit(h.db, { actorUserId: null, actorLabel: "system", action: `test.after_cut_${i}` }, NOW);
}

describe("GET /api/events/{event}/audit/anchor: check a head you saved", () => {
  it("a saved pair holds, also for a row of no event, and after the app wrote on past it", async () => {
    const saved = savePortalHead();
    signIn("usr_organizer");
    expect(await check(saved.entry, saved.hash)).toEqual({ status: 200, body: { entry: saved.entry, hash: saved.hash, holds: true } });
    appendAudit(h.db, { actorUserId: null, actorLabel: "system", action: "test.later", eventId: "evt_01" }, NOW);
    // pasted as the page shows it: groups of eight with spaces, any case, the row with its #
    const spaced = saved.hash.toUpperCase().replace(/(.{8})/g, "$1 ").trim();
    expect(await check(`#${saved.entry}`, spaced)).toMatchObject({ status: 200, body: { holds: true } });
  });

  it("known-bad: after a cut past it, with the sequence lowered and new rows written, the same pair does not hold", async () => {
    const saved = savePortalHead();
    cutFromAndWriteOn(saved.entry - 2, 4);
    expect(lastId()).toBeGreaterThanOrEqual(saved.entry); // row #entry exists again, written after the cut
    expect(verifyAuditChain(h.db).ok).toBe(true); // the chain check alone no longer sees it
    signIn("usr_organizer");
    expect(await check(saved.entry, saved.hash)).toEqual({ status: 200, body: { entry: saved.entry, hash: saved.hash, holds: false } });
  });

  it("a row that is gone, or a hash that is not its own, does not hold", async () => {
    const saved = savePortalHead();
    signIn("usr_organizer");
    expect((await check(saved.entry + 50, saved.hash)).body.holds).toBe(false);
    expect((await check(saved.entry, "0".repeat(64))).body.holds).toBe(false);
  });

  it("no session is 401 with no audit row; a judge of the event is 403, audited; the organizer's same request is 200", async () => {
    const saved = savePortalHead();
    const before = refusals();
    expect(await check(saved.entry, saved.hash)).toMatchObject({ status: 401 });
    expect(refusals()).toBe(before);
    signIn(judgeId());
    expect(await check(saved.entry, saved.hash)).toMatchObject({ status: 403, body: { error: "not_an_organizer" } });
    expect(refusals()).toBe(before + 1);
    expect(await check(saved.entry, saved.hash)).not.toHaveProperty("body.holds");
    signIn("usr_organizer");
    expect(await check(saved.entry, saved.hash)).toMatchObject({ status: 200, body: { holds: true } });
  });

  it("a row number or hash out of form is a 422 naming the field; refused callers get 403 before that", async () => {
    signIn("usr_organizer");
    expect(await check("0", "a".repeat(64))).toMatchObject({ status: 422, body: { error: "invalid", details: { entry: [expect.any(String)] } } });
    expect(await check("12", "abc")).toMatchObject({ status: 422, body: { details: { hash: [expect.any(String)] } } });
    signIn(judgeId());
    expect((await check("0", "abc")).status).toBe(403);
  });

  it("the log page's head text says where to check a saved pair", () => {
    expect(keepHeadText(412, "below")).toContain("Check a pair you saved with the form below, or at GET /api/events/{event}/audit/anchor.");
    expect(keepHeadText(412)).toContain("on an event’s Audit log page");
  });
});
