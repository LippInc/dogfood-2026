import { describe, expect, it } from "vitest";
import { acceptJudgeInvite, inviteJudges, judgeInviteByCode, parseInviteLines } from "@/server/dal/judges";
import { mailJudgeInvites } from "@/server/dal/mailing";
import { verifyAuditChain } from "@/server/audit";
import { getDb } from "@/server/db/client";
import { sha256 } from "@/server/util";
import { HttpError } from "@/server/errors";
import { actorById, addUser, auditRows, count, expectHttpError, organizer, sqlAll, sqlGet, withFixtureEvent } from "./support/fixture-harness";

// Judges were invited one form at a time, while the voter list took a pasted batch: an
// organizer with 30 judges filled the form 30 times. Now a pasted list makes one link each,
// audited per judge; with email on, each link with an address is mailed.

withFixtureEvent();

const TRACKS = [
  { id: "trk_a", name: "Security" },
  { id: "trk_b", name: "Health Tech" },
];

describe("parseInviteLines", () => {
  it("reads name and email, email alone, a name alone (open link), tabs, a line's own tracks, and skips blanks and # lines", () => {
    const lines = parseInviteLines(
      "Mira Ek, Mira@Example.org\n\njon@example.org\n# a comment\nAda Open\nBo Lind\tbo@example.org\nCy, cy@example.org, security; Health Tech\n",
      TRACKS,
      ["trk_a"],
    );
    expect(lines).toEqual([
      { line: 1, name: "Mira Ek", email: "mira@example.org", trackIds: ["trk_a"] },
      { line: 3, name: "", email: "jon@example.org", trackIds: ["trk_a"] },
      { line: 5, name: "Ada Open", email: null, trackIds: ["trk_a"] },
      { line: 6, name: "Bo Lind", email: "bo@example.org", trackIds: ["trk_a"] },
      { line: 7, name: "Cy", email: "cy@example.org", trackIds: ["trk_a", "trk_b"] },
    ]);
  });

  it("names every bad line and makes nothing: a bad address, an unknown track, a repeated address, no tracks at all", () => {
    let caught: unknown;
    try {
      parseInviteLines("Ok, ok@example.org\nBad, not-an@address\nX, x@example.org, Robotics\nOk again, OK@example.org", TRACKS, ["trk_a"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const lines = ((caught as HttpError).details as { lines: string[] }).lines;
    expect(lines).toEqual([
      "line 2: not an email address: not-an@address",
      "line 3: not a track of this event: Robotics",
      "line 4: ok@example.org is on line 1 already",
    ]);
    expect(() => parseInviteLines("Mira, mira@example.org", TRACKS, [])).toThrow(HttpError);
    expect(() => parseInviteLines("\n  \n# only a comment", TRACKS, ["trk_a"])).toThrow(HttpError);
  });
});

describe("inviteJudges", () => {
  it("makes one working link per line, stores only hashes, and writes one judge.invite row each", () => {
    const before = auditRows().length;
    const out = inviteJudges(organizer(), "evt_01", {
      lines: "Mira Ek, mira@example.org\nJon Berg, jon@example.org, " + sqlGet<{ name: string }>("SELECT name FROM tracks WHERE id = 'trk_02'")!.name + "\nOpen One",
      trackIds: ["trk_01"],
    });
    expect(out.invites).toHaveLength(3);
    expect(out.skipped).toEqual([]);
    const rows = sqlAll<{ id: string; code_hash: string; email: string | null; name: string; track_ids: string }>(
      "SELECT id, code_hash, email, name, track_ids FROM judge_invites ORDER BY created_at, id",
    );
    expect(rows).toHaveLength(3);
    for (const inv of out.invites) {
      const row = rows.find((r) => r.id === inv.id)!;
      expect(row.code_hash).toBe(sha256(inv.code));
      expect(judgeInviteByCode(inv.code).state).toBe("open");
    }
    expect(JSON.parse(rows.find((r) => r.email === "jon@example.org")!.track_ids)).toEqual(["trk_02"]);
    expect(JSON.parse(rows.find((r) => r.name === "Open One")!.track_ids)).toEqual(["trk_01"]);

    const invites = auditRows().slice(before);
    expect(invites.map((r) => r.action)).toEqual(["judge.invite", "judge.invite", "judge.invite"]);
    expect(invites.map((r) => r.targetId).sort()).toEqual(out.invites.map((i) => i.id).sort());
    for (const r of invites) {
      for (const inv of out.invites) expect(JSON.stringify([r.before, r.after])).not.toContain(inv.code);
    }
    expect(verifyAuditChain(getDb()).ok).toBe(true);

    const mira = addUser("usr_mira", "mira@example.org", "Mira Ek");
    acceptJudgeInvite(mira, out.invites[0]!.code);
    expect(count("SELECT count(*) AS n FROM user_roles WHERE user_id = 'usr_mira' AND role = 'judge'")).toBe(1);
  });

  it("skips an address that already judges the event, and makes the rest", () => {
    const judge = sqlGet<{ email: string }>("SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.event_id = 'evt_01' AND r.role = 'judge' ORDER BY u.id LIMIT 1")!;
    const out = inviteJudges(organizer(), "evt_01", { lines: `Known, ${judge.email}\nNew, new@example.org`, trackIds: ["trk_01"] });
    expect(out.invites.map((i) => i.email)).toEqual(["new@example.org"]);
    expect(out.skipped).toEqual([{ line: 1, email: judge.email.toLowerCase(), reason: "already a judge in this event" }]);
  });

  it("a bad line stops the whole list: no invitation, no audit row", () => {
    const before = auditRows().length;
    expectHttpError(() => inviteJudges(organizer(), "evt_01", { lines: "Good, good@example.org\nBad, bad@", trackIds: ["trk_01"] }), 422, "invalid");
    expect(count("SELECT count(*) AS n FROM judge_invites")).toBe(0);
    expect(auditRows().length).toBe(before);
  });

  it("refuses no session (401) and anyone but an organizer (403), making nothing", () => {
    expectHttpError(() => inviteJudges(null, "evt_01", { lines: "a@example.org", trackIds: ["trk_01"] }), 401, "unauthenticated");
    expectHttpError(() => inviteJudges(actorById("jdg_24"), "evt_01", { lines: "a@example.org", trackIds: ["trk_01"] }), 403, "not_an_organizer");
    expect(count("SELECT count(*) AS n FROM judge_invites")).toBe(0);
  });

  it("with email off the list is made and nothing is mailed", async () => {
    const out = inviteJudges(organizer(), "evt_01", { lines: "Mira, mira@example.org\nOpen", trackIds: ["trk_01"] });
    const report = await mailJudgeInvites(organizer(), "evt_01", out.invites);
    expect(report).toEqual({ on: false, mailed: [] });
    expect(count("SELECT count(*) AS n FROM outbox")).toBe(0);
  });
});
