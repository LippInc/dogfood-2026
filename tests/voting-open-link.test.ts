import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import {
  castBallot,
  enterVoting,
  getBallot,
  type Client,
} from "@/server/dal/voting";
import {
  getCommunityResults,
  getVotingAdmin,
  makeVotingLink,
  saveVotingSettings,
  voidVoter,
} from "@/server/dal/voting-organizer";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

beforeEach(() => {
  resetRateLimits();
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256: fixtureSha } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256: fixtureSha, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h); // the voting DAL goes through getDb()
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function expectHttpError(call: () => unknown, status: number, code: string) {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to throw").toBeInstanceOf(HttpError);
  const error = caught as HttpError;
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
}

const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();
const auditCount = (action: string) => auditRows().filter((r) => r.action === action).length;

const userIdByEmail = (email: string) =>
  (h.sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as
    | { id: string; name: string; email: string }
    | undefined;
  if (!u) throw new Error(`no user row for ${userId}`);
  const roles = h.db
    .select({ eventId: userRoles.eventId, role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}

const org = () => actorById("usr_organizer");
const participant = () => actorById(userIdByEmail("member1_1@example.org"));

const CLIENT: Client = { ip: "10.0.0.5", agent: "VoterBrowser" };

/** A settings body for evt_01: all three ways to vote, a window open now; countLink left as it is unless overridden. */
const settings = (over: { countLink?: boolean; votesPerVoter?: string } = {}) => ({
  votingOpenAt: "2026-01-01T00:00",
  votingCloseAt: "2999-01-01T00:00",
  modes: ["account", "listed", "link"],
  votesPerVoter: "3",
  ...over,
});

/**
 * The standard window for this file: all three ways to vote, and open-link ballots counted
 * apart (the default), which is the rule under test here.
 */
const openVotingApart = () => saveVotingSettings(org(), "evt_01", settings());

let ipSeq = 0;
const nextIp = () => `10.42.0.${++ipSeq}`;

/** A fresh open-link voter: rotates the link, enters from a fresh network address. */
function linkToken(): string {
  const { code } = makeVotingLink(org(), "evt_01");
  return enterVoting(code, { ip: nextIp(), agent: "Agent" }).token;
}

/** A fresh account voter on no team, so every project is a valid pick for them. */
const newVoter = (id: string) => {
  h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)").run(id, `${id}@example.org`, id, NOW);
  return actorById(id);
};

const ownProjectOf = (userId: string) =>
  (
    h.sqlite
      .prepare("SELECT p.id AS id FROM projects p JOIN team_members m ON m.team_id = p.team_id WHERE m.user_id = ? AND p.event_id = 'evt_01'")
      .get(userId) as { id: string } | undefined
  )?.id;

describe("the default counting rule: open-link ballots are counted apart", () => {
  it("a window opened without countLink counts them apart, and the rule is not yet fixed", () => {
    openVotingApart();
    const { settings: s } = getVotingAdmin(org(), "evt_01");
    expect(s.countLink).toBe(false);
    expect(s.countRuleFixed).toBe(false);
    expect(getBallot(null, "evt_01", linkToken()).countLink).toBe(false);
  });

  it("open-link ballots show in their own column and do not add to the result, live for the organizer and in the public results after the close", () => {
    openVotingApart();
    castBallot(newVoter("usr_ol_acct"), "evt_01", null, { projectIds: ["prj_07"] }, CLIENT);
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_07"] }, CLIENT);
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_08"] }, CLIENT);

    const live = getVotingAdmin(org(), "evt_01").tally!;
    expect(live.find((x) => x.projectId === "prj_07")).toMatchObject({ votes: 1, openLink: 1, place: 1 });
    expect(live.find((x) => x.projectId === "prj_08")).toMatchObject({ votes: 0, openLink: 1, place: null });

    h.sqlite.prepare("UPDATE events SET voting_close_at = '2026-01-02T00:00:00.000Z' WHERE id = 'evt_01'").run();
    const results = getCommunityResults("evt_01");
    expect(results.state).toBe("closed");
    expect(results.countLink).toBe(false);
    expect(results.tally!.find((x) => x.projectId === "prj_07")).toMatchObject({ votes: 1, openLink: 1, place: 1 });
    expect(results.tally!.find((x) => x.projectId === "prj_08")).toMatchObject({ votes: 0, openLink: 1, place: null });
  });
});

describe("the organizer can count open-link ballots instead", () => {
  it("countLink: true before the first ballot folds them into the result and the places", () => {
    saveVotingSettings(org(), "evt_01", settings({ countLink: true }));
    expect(getVotingAdmin(org(), "evt_01").settings.countLink).toBe(true);
    castBallot(newVoter("usr_ol_acct_b"), "evt_01", null, { projectIds: ["prj_07"] }, CLIENT);
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_07"] }, CLIENT);
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_08"] }, CLIENT);

    const live = getVotingAdmin(org(), "evt_01").tally!;
    expect(live.find((x) => x.projectId === "prj_07")).toMatchObject({ votes: 2, openLink: 1, place: 1 });
    expect(live.find((x) => x.projectId === "prj_08")).toMatchObject({ votes: 1, openLink: 1, place: 2 });
  });
});

describe("the rule is fixed from the first ballot", () => {
  it("flips freely before any ballot, one audit row per flip naming the new value; after a ballot a flip is 409 and changes nothing, while saves that keep the rule still go through", () => {
    openVotingApart();

    const rows = () => auditRows().filter((r) => r.action === "voting.settings");
    const lastAfter = () => (rows().at(-1)!.after as { countLink: boolean }).countLink;
    const beforeRows = rows().length;

    saveVotingSettings(org(), "evt_01", settings({ countLink: true }));
    expect(getVotingAdmin(org(), "evt_01").settings.countLink).toBe(true);
    expect(rows()).toHaveLength(beforeRows + 1);
    expect(lastAfter()).toBe(true);
    saveVotingSettings(org(), "evt_01", settings({ countLink: false }));
    expect(getVotingAdmin(org(), "evt_01").settings.countLink).toBe(false);
    expect(rows()).toHaveLength(beforeRows + 2);
    expect(lastAfter()).toBe(false);

    // one ballot, from a link voter: the rule is fixed from then on
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_01"] }, CLIENT);
    expect(getVotingAdmin(org(), "evt_01").settings.countRuleFixed).toBe(true);

    const settingsBefore = getVotingAdmin(org(), "evt_01").settings;
    expectHttpError(() => saveVotingSettings(org(), "evt_01", settings({ countLink: true })), 409, "count_rule_fixed");
    expect(getVotingAdmin(org(), "evt_01").settings).toEqual(settingsBefore);
    expect(auditCount("voting.settings")).toBe(beforeRows + 2); // the refused flip wrote no row

    // positive controls: with ballots in, saves that leave countLink out, or send the current
    // value, still succeed (here raising the pick limit, which needs a reason once ballots are in), and countLink keeps its value
    saveVotingSettings(org(), "evt_01", { ...settings({ votesPerVoter: "4" }), reason: "Four favourites, as announced" });
    saveVotingSettings(org(), "evt_01", settings({ countLink: false, votesPerVoter: "4" }));
    const s = getVotingAdmin(org(), "evt_01").settings;
    expect(s.countLink).toBe(false);
    expect(s.votesPerVoter).toBe(4);
  });

  it("a save that leaves countLink out keeps it as it is, before and after the first ballot", () => {
    saveVotingSettings(org(), "evt_01", settings({ countLink: true }));
    saveVotingSettings(org(), "evt_01", settings({ votesPerVoter: "4" })); // before any ballot: no quiet reset
    expect(getVotingAdmin(org(), "evt_01").settings.countLink).toBe(true);
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_08"] }, CLIENT);
    saveVotingSettings(org(), "evt_01", { ...settings({ votesPerVoter: "5" }), reason: "Five favourites, as announced" }); // after it: no 409, and still counted
    const admin = getVotingAdmin(org(), "evt_01");
    expect(admin.settings).toMatchObject({ countLink: true, votesPerVoter: 5 });
    expect(admin.tally!.find((x) => x.projectId === "prj_08")).toMatchObject({ votes: 1, openLink: 1 });
  });

  it("an emptied ballot still fixes the rule", () => {
    openVotingApart();
    const own = ownProjectOf(participant().userId);
    const pick = ["prj_05", "prj_06"].find((id) => id !== own)!;
    castBallot(participant(), "evt_01", null, { projectIds: [pick] }, CLIENT);
    castBallot(participant(), "evt_01", null, { projectIds: [] }, CLIENT);
    expectHttpError(() => saveVotingSettings(org(), "evt_01", settings({ countLink: true })), 409, "count_rule_fixed");
  });
});

describe("a voided open-link ballot", () => {
  it("leaves the openLink column too: set aside before the count, it shows in neither number", () => {
    openVotingApart();
    const first = castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_08"] }, CLIENT);
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_08"] }, CLIENT);

    const row = () => getVotingAdmin(org(), "evt_01").tally!.find((x) => x.projectId === "prj_08")!;
    expect(row()).toMatchObject({ votes: 0, openLink: 2 }); // positive control: both link ballots show before the void

    voidVoter(org(), "evt_01", { voterId: first.voterId, reason: "Same browser as another ballot" });
    expect(row()).toMatchObject({ votes: 0, openLink: 1 });
  });
});

describe("one ballot per browser: the open link hands a browser back the ballot it holds", () => {
  const linkBallots = () => (h.sqlite.prepare("SELECT COUNT(*) AS n FROM voters WHERE event_id = 'evt_01' AND kind = 'link'").get() as { n: number }).n;

  it("entering again with this event's ballot cookie resumes that ballot: no second ballot, no second join row", () => {
    openVotingApart();
    const { code } = makeVotingLink(org(), "evt_01");
    const first = enterVoting(code, CLIENT).token;
    castBallot(null, "evt_01", first, { projectIds: ["prj_08"] }, CLIENT);

    const again = enterVoting(code, CLIENT, (eventId) => (eventId === "evt_01" ? first : undefined));
    expect(again.token).toBe(first);
    expect(linkBallots()).toBe(1);
    expect(auditCount("voter.join_link")).toBe(1);
    expect(getBallot(null, "evt_01", again.token).picks).toEqual(["prj_08"]);
  });

  it("a browser holding no ballot, or a token that is no ballot of this event, gets a new one (the positive control)", () => {
    openVotingApart();
    const { code } = makeVotingLink(org(), "evt_01");
    const first = enterVoting(code, CLIENT).token;
    expect(enterVoting(code, CLIENT).token).not.toBe(first); // another browser: no cookie
    expect(enterVoting(code, CLIENT, () => "no-such-ballot").token).not.toBe(first);
    expect(linkBallots()).toBe(3);
    expect(auditCount("voter.join_link")).toBe(3);
  });

  it("a ballot the organizer set aside stays set aside: entering again resumes it instead of handing out a fresh, counted one", () => {
    openVotingApart();
    const { code } = makeVotingLink(org(), "evt_01");
    const token = enterVoting(code, CLIENT).token;
    const cast = castBallot(null, "evt_01", token, { projectIds: ["prj_08"] }, CLIENT);
    voidVoter(org(), "evt_01", { voterId: cast.voterId, reason: "Same browser as another ballot" });

    expect(enterVoting(code, CLIENT, () => token).token).toBe(token);
    expect(linkBallots()).toBe(1);
    const row = getVotingAdmin(org(), "evt_01").tally!.find((x) => x.projectId === "prj_08");
    expect(row?.openLink ?? 0).toBe(0);
  });

  it("a new open link still resumes the ballot a browser made through the old one", () => {
    openVotingApart();
    const old = makeVotingLink(org(), "evt_01").code;
    const token = enterVoting(old, CLIENT).token;
    const rotated = makeVotingLink(org(), "evt_01").code;
    expect(enterVoting(rotated, CLIENT, () => token).token).toBe(token);
    expect(linkBallots()).toBe(1);
  });
});
