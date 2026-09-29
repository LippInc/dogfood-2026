import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { publishResults } from "@/server/dal/results";
import { savePrizes } from "@/server/dal/organize";
import { exportFile, EXPORT_FILES } from "@/server/dal/exports";
import { getAuditLog } from "@/server/dal/audit-log";
import { getOverview } from "@/server/dal/overview";
import { awardPrize, getPrizeAwards, prizesWonBy, publishedPrizes } from "@/server/dal/prize-awards";
import { getRecord, issueOwnRecord, verifyRecord } from "@/server/dal/records";
import type { Actor } from "@/server/authz";

// Prizes given to projects (JUDGING.md, "Prizes"): an organizer awards each prize to one project or several
// (joint) before publishing, each change one audited action; publishing makes the awards final in the app (409)
// and in the database (triggers.ts); the public results, a winner's page and its certificate show them. An event
// that awards nothing keeps its exports, settings and certificates exactly as before.

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function actor(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}
const organizer = () => actor("usr_organizer");
const judge = () => actor("jdg_01");

function expectHttp(call: () => unknown, status: number, code?: string) {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to throw").toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(status);
  if (code) expect((caught as HttpError).code).toBe(code);
  return caught as HttpError;
}

const settings = () => JSON.parse((h.sqlite.prepare("SELECT settings FROM events WHERE id = 'evt_01'").get() as { settings: string }).settings) as Record<string, unknown>;
const auditOf = (action: string) => h.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(auditLog.id).all();
const prizeIds = () => (h.sqlite.prepare("SELECT id FROM prizes WHERE event_id = 'evt_01' ORDER BY position").all() as { id: string }[]).map((r) => r.id);

/** Two prizes on the sample event: "Best hack" and "Most creative". */
function twoPrizes() {
  savePrizes(organizer(), "evt_01", [{ name: "Best hack", description: "The judges' favourite" }, { name: "Most creative" }]);
  return prizeIds() as [string, string];
}

/** A member of the team whose project is prj_01, the project the tests award. */
function memberOf(projectId: string): Actor {
  const row = h.sqlite.prepare("SELECT tm.user_id AS id FROM team_members tm JOIN projects p ON p.team_id = tm.team_id WHERE p.id = ? LIMIT 1").get(projectId) as { id: string };
  return actor(row.id);
}

/** Settle the fixture's three decisions and publish, as tests/records.test.ts does. */
function publish() {
  setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  publishResults(organizer(), "evt_01");
}

describe("awarding a prize before publishing", () => {
  it("gives a prize to one project, logged as one audited action with the prize and the winner", () => {
    const [best] = twoPrizes();
    const out = awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01"], note: "Clear demo" });
    expect(out.changed).toBe(true);
    const view = getPrizeAwards(organizer(), "evt_01");
    expect(view.published).toBe(false);
    expect(view.prizes.map((p) => [p.name, p.winners.map((w) => w.projectId), p.note])).toEqual([
      ["Best hack", ["prj_01"], "Clear demo"],
      ["Most creative", [], ""],
    ]);
    const rows = auditOf("prize.award");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe(best);
    expect(rows[0]!.after).toMatchObject({ prize: "Best hack", projects: [{ id: "prj_01", title: "Glass Signal" }], note: "Clear demo" });
    const line = getAuditLog(organizer(), "evt_01", { limit: 50 }).lines.find((l) => l.action === "prize.award")!;
    expect(line.parts.map((p) => p.text).join("")).toMatch(/awarded the prize “Best hack” to Glass Signal, noting “Clear demo”/);
    // the Overview's log card lists it with the other decisions
    expect(getOverview(organizer(), "evt_01").audit[0]!.action).toBe("prize.award");
  });

  it("a joint award names every winner; the certificate words say joint", () => {
    const [best] = twoPrizes();
    awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01", "prj_02"] });
    expect(getPrizeAwards(organizer(), "evt_01").prizes[0]!.winners.map((w) => w.projectId)).toEqual(["prj_01", "prj_02"]);
    publish();
    expect(prizesWonBy("evt_01", "prj_02")).toEqual([{ name: "Best hack", joint: true }]);
  });

  it("taking a prize back (no projects) leaves it unawarded and the settings as they were before any award", () => {
    const [best] = twoPrizes();
    const before = settings();
    awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01"] });
    expect(settings().prizeAwards).toHaveLength(1);
    awardPrize(organizer(), "evt_01", best, { projectIds: [] });
    expect(settings()).toEqual(before);
    expect("prizeAwards" in settings()).toBe(false);
    expect(auditOf("prize.award").map((r) => (r.after as { projects: unknown[] }).projects.length)).toEqual([1, 0]);
  });

  it("sending what is stored changes nothing and logs nothing", () => {
    const [best] = twoPrizes();
    awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01"], note: "x" });
    expect(awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01"], note: "x" }).changed).toBe(false);
    expect(auditOf("prize.award")).toHaveLength(1);
  });

  it("removing an awarded prize in Settings takes its award with it, in the same audited save", () => {
    const [best, creative] = twoPrizes();
    awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01"] });
    awardPrize(organizer(), "evt_01", creative, { projectIds: ["prj_02"] });
    savePrizes(organizer(), "evt_01", [{ id: creative, name: "Most creative" }]);
    expect((settings().prizeAwards as { prizeId: string }[]).map((a) => a.prizeId)).toEqual([creative]);
    const last = auditOf("prize.award").at(-1)!;
    expect(last.targetId).toBe(best);
    expect(last.after).toMatchObject({ projects: [], removed: true });
  });

  it("known-bad: a project not in the event, a merged copy, or one named twice is a 422 and nothing changes", () => {
    const [best] = twoPrizes();
    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    expectHttp(() => awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_nope"] }), 422, "invalid");
    expectHttp(() => awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_41"] }), 422, "invalid");
    expectHttp(() => awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01", "prj_01"] }), 422, "invalid");
    expect("prizeAwards" in settings()).toBe(false);
    expectHttp(() => awardPrize(organizer(), "evt_01", "prz_not_ours", { projectIds: ["prj_01"] }), 404, "not_found");
  });
});

describe("who may award and read", () => {
  it("no session is 401, a judge or a team member 403 (logged); the organizer is the positive control", () => {
    const [best] = twoPrizes();
    expectHttp(() => awardPrize(null, "evt_01", best, { projectIds: ["prj_01"] }), 401);
    expectHttp(() => awardPrize(judge(), "evt_01", best, { projectIds: ["prj_01"] }), 403);
    expectHttp(() => awardPrize(memberOf("prj_01"), "evt_01", best, { projectIds: ["prj_01"] }), 403);
    expect(auditOf("authz.refused").length).toBe(2);
    expect("prizeAwards" in settings()).toBe(false);
    expect(awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01"] }).changed).toBe(true);
  });

  it("GET before publishing: 401 without a session, 403 for a judge; public once published", () => {
    const [best] = twoPrizes();
    awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01"] });
    expectHttp(() => getPrizeAwards(null, "evt_01"), 401);
    expectHttp(() => getPrizeAwards(judge(), "evt_01"), 403);
    expect(publishedPrizes("evt_01")).toEqual([]);
    publish();
    const open = getPrizeAwards(null, "evt_01");
    expect(open.published).toBe(true);
    expect(open.prizes[0]!.winners.map((w) => w.projectId)).toEqual(["prj_01"]);
    expect(publishedPrizes("evt_01").map((p) => p.name)).toEqual(["Best hack", "Most creative"]);
  });
});

describe("final with the results", () => {
  it("after publishing, a change is 409 in the app, and the prize list is final too", () => {
    const [best, creative] = twoPrizes();
    awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01"] });
    publish();
    expectHttp(() => awardPrize(organizer(), "evt_01", creative, { projectIds: ["prj_02"] }), 409, "results_published");
    expectHttp(() => awardPrize(organizer(), "evt_01", best, { projectIds: [] }), 409, "results_published");
    expectHttp(() => savePrizes(organizer(), "evt_01", [{ id: best, name: "Renamed" }]), 409, "results_published");
    expect(publishedPrizes("evt_01")[0]!.winners.map((w) => w.projectId)).toEqual(["prj_01"]);
  });

  it("positive control: an event published with no prize awarded keeps its prizes editable", () => {
    const [best] = twoPrizes();
    publish();
    savePrizes(organizer(), "evt_01", [{ id: best, name: "Best hack, renamed" }]);
    expect(prizeIds()).toEqual([best]);
  });

  it("the database refuses a direct write to the awards, or to an awarded event's prizes, once published", () => {
    const [best] = twoPrizes();
    awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01"] });
    // positive control: before publishing, the same direct writes pass
    h.sqlite.prepare("UPDATE prizes SET description = 'x' WHERE id = ?").run(best);
    publish();
    const swap = JSON.stringify({ ...settings(), prizeAwards: [{ prizeId: best, projectIds: ["prj_02"], note: "", at: NOW }] });
    expect(() => h.sqlite.prepare("UPDATE events SET settings = ? WHERE id = 'evt_01'").run(swap)).toThrow(/prize awards are final/);
    const without = { ...settings() };
    delete without.prizeAwards;
    expect(() => h.sqlite.prepare("UPDATE events SET settings = ? WHERE id = 'evt_01'").run(JSON.stringify(without))).toThrow(/prize awards are final/);
    expect(() => h.sqlite.prepare("UPDATE prizes SET name = 'x' WHERE id = ?").run(best)).toThrow(/awarded prizes are final/);
    expect(() => h.sqlite.prepare("DELETE FROM prizes WHERE id = ?").run(best)).toThrow(/awarded prizes are final/);
    expect(() => h.sqlite.prepare("INSERT INTO prizes (id, event_id, name, description, position) VALUES ('prz_new', 'evt_01', 'New', '', 9)").run()).toThrow(
      /awarded prizes are final/,
    );
    // an unrelated setting still changes after publishing (the accent), the awards untouched
    h.sqlite.prepare("UPDATE events SET settings = ? WHERE id = 'evt_01'").run(JSON.stringify({ ...settings(), accent: "blue" }));
    expect(settings().prizeAwards).toHaveLength(1);
  });
});

describe("what the winners get", () => {
  it("the certificate adds Winner, <prize>, and still verifies", () => {
    const [best] = twoPrizes();
    awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01"] });
    publish();
    const view = getRecord(issueOwnRecord(memberOf("prj_01"), "evt_01", "participant").id);
    const awards = (view.envelope.record as { project: { awards: string[] } }).project.awards;
    expect(awards).toContain("Winner, Best hack");
    expect(view.verification.valid).toBe(true);
    expect(verifyRecord(view.envelope).valid).toBe(true);
  });

  it("with prizes but no award, certificates, exports and settings are exactly as without prizes", () => {
    const exportsNow = () =>
      EXPORT_FILES.filter((f) => f !== "awards.csv").map((f) => {
        const body = exportFile(organizer(), "evt_01", f).body;
        // event.json carries the time it was made, and the audit log grows with every save
        return f === "event.json" ? body.replace(/"exportedAt": "[^"]+"/, "") : f === "audit.csv" ? "" : body;
      });
    const [best] = twoPrizes();
    const before = exportsNow();
    const settingsBefore = settings();
    awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01"] });
    awardPrize(organizer(), "evt_01", best, { projectIds: [] });
    expect(exportsNow()).toEqual(before);
    expect(settings()).toEqual(settingsBefore);
    publish();
    const awards = (getRecord(issueOwnRecord(memberOf("prj_01"), "evt_01", "participant").id).envelope.record as { project: { awards: string[] } }).project.awards;
    expect(awards.some((a) => /^(Joint winner|Winner), /.test(a))).toBe(false);
    expect(publishedPrizes("evt_01")).toEqual([]);
  });

  it("awards.csv lists every prize: a row per winner, an unawarded prize with empty project columns; event.json carries the awards", () => {
    const [best] = twoPrizes();
    awardPrize(organizer(), "evt_01", best, { projectIds: ["prj_01", "prj_02"], note: "Tied, fairly" });
    const lines = exportFile(organizer(), "evt_01", "awards.csv").body.trim().split(/\r?\n/);
    expect(lines[0]).toBe("prize_id,prize,description,status,project_id,title,team,track,joint,note,awarded_at");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(new RegExp(`^${best},Best hack,The judges' favourite,draft,prj_01,Glass Signal,NorthKiln,Security,yes,"?Tied, fairly"?,`));
    expect(lines[3]).toMatch(/,Most creative,,unawarded,,,,,,,$/);
    const json = JSON.parse(exportFile(organizer(), "evt_01", "event.json").body) as { event: { settings: { prizeAwards: { prizeId: string; projectIds: string[] }[] } } };
    expect(json.event.settings.prizeAwards).toMatchObject([{ prizeId: best, projectIds: ["prj_01", "prj_02"], note: "Tied, fairly" }]);
    publish();
    expect(exportFile(organizer(), "evt_01", "awards.csv").body).toMatch(/,final,prj_01,/);
  });
});
