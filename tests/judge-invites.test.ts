import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { sha256 } from "@/server/util";
import { acceptJudgeInvite, inviteJudge, judgeInviteByCode, revokeJudgeInvite, setJudgeTracks } from "@/server/dal/judges";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256: fixtureSha } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256: fixtureSha, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h); // the judge DAL goes through getDb()
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

const count = (sql: string) => (h.sqlite.prepare(sql).get() as { n: number }).n;
const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();

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

function addUser(id: string, email: string, name: string): Actor {
  h.sqlite
    .prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)")
    .run(id, email, name, NOW);
  return actorById(id);
}

const organizer = () => actorById("usr_organizer");

type InviteRow = {
  id: string;
  code_hash: string;
  email: string | null;
  track_ids: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
};
const inviteRow = (id: string) => h.sqlite.prepare("SELECT * FROM judge_invites WHERE id = ?").get(id) as InviteRow;
const tracksOf = (judgeUserId: string) =>
  (
    h.sqlite
      .prepare("SELECT track_id AS t FROM judge_tracks WHERE event_id = 'evt_01' AND judge_user_id = ? ORDER BY track_id")
      .all(judgeUserId) as { t: string }[]
  ).map((r) => r.t);
const isJudgeInEvt01 = (userId: string) =>
  Boolean(
    h.sqlite.prepare("SELECT 1 AS x FROM user_roles WHERE user_id = ? AND event_id = 'evt_01' AND role = 'judge'").get(userId),
  );

describe("inviteJudge", () => {
  it("refuses a missing session with 401 and writes no audit row", () => {
    const before = auditRows().length;
    expectHttpError(() => inviteJudge(null, "evt_01", { name: "Mira", email: "", trackIds: ["trk_01"] }), 401, "unauthenticated");
    expect(auditRows().length).toBe(before);
    expect(count("SELECT count(*) AS n FROM judge_invites")).toBe(0);
  });

  it("refuses a plain new user with 403 not_an_organizer and exactly one authz.refused audit row", () => {
    const outsider = addUser("usr_plain", "plain@example.org", "Plain");
    const before = auditRows().length;
    const refusalsBefore = auditRows().filter((r) => r.action === "authz.refused").length;

    expectHttpError(() => inviteJudge(outsider, "evt_01", { name: "X", email: "", trackIds: ["trk_01"] }), 403, "not_an_organizer");

    expect(count("SELECT count(*) AS n FROM judge_invites")).toBe(0);
    const rows = auditRows();
    expect(rows).toHaveLength(before + 1); // the refusal is the only new row
    const refusals = rows.filter((r) => r.action === "authz.refused");
    expect(refusals).toHaveLength(refusalsBefore + 1);
    expect(JSON.stringify(refusals.at(-1)!.after)).toContain('"code":"not_an_organizer"');
  });

  it("creates a letters-and-digits code, stores only its sha256, audits without the code, chain intact", () => {
    const out = inviteJudge(organizer(), "evt_01", {
      name: "Mira",
      email: "Mira@Example.org",
      trackIds: ["trk_01", "trk_02"],
    });

    expect(out.id.startsWith("jinv_")).toBe(true);
    expect(out.code).toMatch(/^[A-Za-z0-9]+$/);
    expect(out.path).toBe(`/judge-invite/${out.code}`);

    const row = inviteRow(out.id);
    expect(row.code_hash).toBe(sha256(out.code)); // only the hash is stored
    expect(row.email).toBe("mira@example.org"); // lowercased
    expect(row.accepted_at).toBeNull();
    expect(row.revoked_at).toBeNull();
    expect(JSON.parse(row.track_ids)).toEqual(["trk_01", "trk_02"]);

    for (const r of auditRows()) {
      expect(JSON.stringify([r.before, r.after])).not.toContain(out.code); // a credential never enters the log
    }
    const invites = auditRows().filter((r) => r.action === "judge.invite");
    expect(invites).toHaveLength(1);
    expect(invites[0]!.targetId).toBe(out.id);
    expect(invites[0]!.eventId).toBe("evt_01");
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("rejects an empty track list, an unknown track and a malformed email with 422 invalid", () => {
    const before = auditRows().length;
    expectHttpError(() => inviteJudge(organizer(), "evt_01", { name: "A", email: "", trackIds: [] }), 422, "invalid");
    expectHttpError(() => inviteJudge(organizer(), "evt_01", { name: "A", email: "", trackIds: ["trk_nope"] }), 422, "invalid");
    expectHttpError(() => inviteJudge(organizer(), "evt_01", { name: "A", email: "not-an-email", trackIds: ["trk_01"] }), 422, "invalid");
    expect(count("SELECT count(*) AS n FROM judge_invites")).toBe(0);
    expect(auditRows().length).toBe(before);
  });

  it("refuses an invite for an address that already judges this event with 409 already_a_judge", () => {
    const email = (h.sqlite.prepare("SELECT email FROM users WHERE id = 'jdg_24'").get() as { email: string }).email;
    expectHttpError(
      () => inviteJudge(organizer(), "evt_01", { name: "Diego again", email, trackIds: ["trk_01"] }),
      409,
      "already_a_judge",
    );
    expect(count("SELECT count(*) AS n FROM judge_invites")).toBe(0);
  });
});

describe("judgeInviteByCode", () => {
  it("shows the event slug, the track names (not ids) and the open state", () => {
    const { code } = inviteJudge(organizer(), "evt_01", { name: "Mira", email: "", trackIds: ["trk_02", "trk_01"] });
    const view = judgeInviteByCode(code);
    expect(view.event.slug).toBe("sample-hack-2026");
    expect(view.tracks).toEqual(["Developer tools", "Data and analytics"]);
    expect(view.state).toBe("open");
  });

  it("refuses an unknown code with 404", () => {
    expectHttpError(() => judgeInviteByCode("nope"), 404, "not_found");
  });
});

describe("acceptJudgeInvite (email-bound link)", () => {
  function boundInvite() {
    const out = inviteJudge(organizer(), "evt_01", { name: "Mira", email: "mira@example.org", trackIds: ["trk_01", "trk_02"] });
    return { code: out.code, id: out.id };
  }

  it("refuses a user with another address with 403 invite_for_someone_else and one authz.refused row", () => {
    const { code } = boundInvite();
    const other = addUser("usr_other", "other@example.org", "Other");
    const before = auditRows().length;

    expectHttpError(() => acceptJudgeInvite(other, code), 403, "invite_for_someone_else");

    const rows = auditRows();
    expect(rows).toHaveLength(before + 1);
    expect(rows.filter((r) => r.action === "authz.refused")).toHaveLength(1);
    expect(JSON.stringify(rows.filter((r) => r.action === "authz.refused")[0]!.after)).toContain('"invite_for_someone_else"');
    expect(count("SELECT count(*) AS n FROM judge_invites WHERE accepted_at IS NOT NULL")).toBe(0); // unused
    expect(isJudgeInEvt01(other.userId)).toBe(false);
  });

  it("gives the bound user the judge role, the invite's tracks and a used invite; repeating is a no-op", () => {
    const { code, id } = boundInvite();
    const mira = addUser("usr_mira", "mira@example.org", "Mira");
    const before = auditRows().length;

    const out = acceptJudgeInvite(mira, code);

    expect(out.eventSlug).toBe("sample-hack-2026");
    expect(isJudgeInEvt01(mira.userId)).toBe(true);
    expect(tracksOf(mira.userId)).toEqual(["trk_01", "trk_02"]);
    expect(inviteRow(id).accepted_by).toBe(mira.userId);
    expect(judgeInviteByCode(code).state).toBe("used");
    const rows = auditRows();
    expect(rows).toHaveLength(before + 1); // the join is the only new row
    const joins = rows.filter((r) => r.action === "judge.join");
    expect(joins).toHaveLength(1);
    expect(verifyAuditChain(h.db).ok).toBe(true);

    // the same user accepting again returns ok and writes nothing new
    const after = auditRows().length;
    expect(acceptJudgeInvite(mira, code).eventSlug).toBe("sample-hack-2026");
    expect(auditRows().length).toBe(after);
    expect(count(`SELECT count(*) AS n FROM judge_tracks WHERE judge_user_id = '${mira.userId}'`)).toBe(2); // no duplicate track rows
  });
});

describe("acceptJudgeInvite (open link)", () => {
  it("lets any signed-in user accept; a later second user gets 409 invite_used", () => {
    const { code } = inviteJudge(organizer(), "evt_01", { name: "Anyone", email: "", trackIds: ["trk_05"] });
    const a = addUser("usr_any_a", "anya@example.org", "Any A");
    const b = addUser("usr_any_b", "anyb@example.org", "Any B");

    acceptJudgeInvite(a, code);
    expect(isJudgeInEvt01(a.userId)).toBe(true);
    expect(tracksOf(a.userId)).toEqual(["trk_05"]);

    expectHttpError(() => acceptJudgeInvite(b, code), 409, "invite_used");
    expect(isJudgeInEvt01(b.userId)).toBe(false);
  });
});

describe("revokeJudgeInvite", () => {
  it("makes the code stop resolving and refuse acceptance, with one judge.invite_revoke row", () => {
    const { code, id } = inviteJudge(organizer(), "evt_01", { name: "Late", email: "", trackIds: ["trk_04"] });
    revokeJudgeInvite(organizer(), id);

    expectHttpError(() => judgeInviteByCode(code), 404, "not_found");
    const u = addUser("usr_rev", "rev@example.org", "Rev");
    expectHttpError(() => acceptJudgeInvite(u, code), 404, "not_found");
    expect(isJudgeInEvt01(u.userId)).toBe(false);

    const revokes = auditRows().filter((r) => r.action === "judge.invite_revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.targetId).toBe(id);
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("revoking twice writes no second audit row", () => {
    const { id } = inviteJudge(organizer(), "evt_01", { name: "Late", email: "", trackIds: ["trk_04"] });
    revokeJudgeInvite(organizer(), id);
    const before = auditRows().length;

    revokeJudgeInvite(organizer(), id);

    expect(auditRows().length).toBe(before);
    expect(inviteRow(id).revoked_at).not.toBeNull();
  });

  it("refuses revoking a used invite with 409 invite_used", () => {
    const { code, id } = inviteJudge(organizer(), "evt_01", { name: "Mira", email: "mira@example.org", trackIds: ["trk_01"] });
    const mira = addUser("usr_mira2", "mira@example.org", "Mira");
    acceptJudgeInvite(mira, code);

    expectHttpError(() => revokeJudgeInvite(organizer(), id), 409, "invite_used");
    expect(inviteRow(id).accepted_by).toBe(mira.userId); // untouched
  });
});

describe("setJudgeTracks", () => {
  it("replaces a judge's tracks, audits before and after, and repeats write nothing", () => {
    expect(tracksOf("jdg_24")).toEqual(["trk_01", "trk_07"]); // the fixture's claim
    const before = auditRows().length;

    const out = setJudgeTracks(organizer(), "evt_01", "jdg_24", { trackIds: ["trk_03"] });

    expect(out.trackIds).toEqual(["trk_03"]);
    expect(tracksOf("jdg_24")).toEqual(["trk_03"]);
    const rows = auditRows();
    expect(rows).toHaveLength(before + 1);
    const changes = rows.filter((r) => r.action === "judge.tracks");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.targetId).toBe("jdg_24");
    expect(changes[0]!.before).toEqual({ trackIds: ["trk_01", "trk_07"] });
    expect(changes[0]!.after).toEqual({ trackIds: ["trk_03"] });
    expect(verifyAuditChain(h.db).ok).toBe(true);

    const again = auditRows().length;
    setJudgeTracks(organizer(), "evt_01", "jdg_24", { trackIds: ["trk_03"] });
    expect(auditRows().length).toBe(again); // unchanged → no new row
    expect(tracksOf("jdg_24")).toEqual(["trk_03"]);
  });

  it("refuses a user who is not a judge in the event with 404", () => {
    const plain = addUser("usr_plain2", "plain2@example.org", "Plain Two");
    expectHttpError(() => setJudgeTracks(organizer(), "evt_01", plain.userId, { trackIds: ["trk_03"] }), 404, "not_found");
  });

  it("known-bad: a participant cannot change a judge's tracks", () => {
    const outsider = addUser("usr_nosy", "nosy@example.org", "Nosy");
    expectHttpError(() => setJudgeTracks(outsider, "evt_01", "jdg_24", { trackIds: ["trk_05"] }), 403, "not_an_organizer");
    expect(tracksOf("jdg_24")).toEqual(["trk_01", "trk_07"]); // unchanged
  });
});

describe("one open invitation per address", () => {
  it("inviting the same address again replaces the open invitation: the old link stops working, the new one works, and the replacement is audited", () => {
    const first = inviteJudge(organizer(), "evt_01", { name: "Mira", email: "mira@example.org", trackIds: ["trk_01"] });
    const second = inviteJudge(organizer(), "evt_01", { name: "Mira", email: "mira@example.org", trackIds: ["trk_01"] });
    expect(second.replaced).toBe(1);
    expect(inviteRow(first.id).revoked_at).not.toBeNull();
    expect(inviteRow(second.id).revoked_at).toBeNull();
    expectHttpError(() => judgeInviteByCode(first.code), 404, "not_found");
    expect(judgeInviteByCode(second.code).state).toBe("open");
    expect(count("SELECT count(*) AS n FROM judge_invites WHERE email = 'mira@example.org' AND accepted_at IS NULL AND revoked_at IS NULL")).toBe(1);
    const revoked = auditRows().filter((r) => r.action === "judge.invite_revoke");
    expect(revoked.map((r) => [r.targetId, r.after])).toEqual([[first.id, { replacedBy: second.id }]]);
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("positive controls: another address, an open link without one, and an accepted invitation are left alone", () => {
    const mira = inviteJudge(organizer(), "evt_01", { name: "Mira", email: "mira@example.org", trackIds: ["trk_01"] });
    const openA = inviteJudge(organizer(), "evt_01", { name: "Open", email: "", trackIds: ["trk_01"] });
    const openB = inviteJudge(organizer(), "evt_01", { name: "Open", email: "", trackIds: ["trk_01"] });
    const other = inviteJudge(organizer(), "evt_01", { name: "Noor", email: "noor@example.org", trackIds: ["trk_01"] });
    expect([mira, openA, openB, other].map((i) => i.replaced)).toEqual([0, 0, 0, 0]);
    for (const i of [mira, openA, openB, other]) expect(inviteRow(i.id).revoked_at).toBeNull();
    const pat = addUser("usr_pat", "pat@example.org", "Pat");
    const used = inviteJudge(organizer(), "evt_01", { name: "Pat", email: "pat@example.org", trackIds: ["trk_01"] });
    acceptJudgeInvite(pat, used.code);
    // Pat judges now: a new invitation is refused as before, and the used one keeps its outcome
    expectHttpError(() => inviteJudge(organizer(), "evt_01", { name: "Pat", email: "pat@example.org", trackIds: ["trk_01"] }), 409, "already_a_judge");
    expect(inviteRow(used.id).accepted_at).not.toBeNull();
    expect(inviteRow(used.id).revoked_at).toBeNull();
  });
});
