import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { getPublishedResults, publishResults } from "@/server/dal/results";
import { getTeamChangesAfterClose, renameTeam } from "@/server/dal/teams";
import type { Actor } from "@/server/authz";

// An organizer's change to a team after submissions close (the team the judges saw) is
// marked on both results pages, not only on the project page: read for the whole event
// in one query, on the public results for everyone, on the organizers' page for them only.

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

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}
const org = () => actorById("usr_organizer");
const teamOf = (projectId: string) => (h.sqlite.prepare("SELECT team_id AS t FROM projects WHERE id = ?").get(projectId) as { t: string }).t;
const memberOf = (teamId: string) => (h.sqlite.prepare("SELECT user_id AS u FROM team_members WHERE team_id = ? LIMIT 1").get(teamId) as { u: string }).u;

function statusOf(call: () => unknown): number | null {
  try {
    call();
    return null;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

describe("a team changed by the organizers after the close, on the results pages", () => {
  it("the organizers' page reads every changed team of the event at once, with the time of the last change", () => {
    expect(getTeamChangesAfterClose(org(), "evt_01").size).toBe(0);
    const team = teamOf("prj_01");
    renameTeam(org(), team, { name: "Glass Signal Crew", reason: "The team asked by mail; a typo" });
    const changes = getTeamChangesAfterClose(org(), "evt_01");
    expect([...changes.keys()]).toEqual(["prj_01"]);
    expect(changes.get("prj_01")!.teamId).toBe(team);
    expect(Date.parse(changes.get("prj_01")!.at)).not.toBeNaN();
  });

  it("only the event's organizers read it: 401 without an account, 403 for a team member", () => {
    const member = actorById(memberOf(teamOf("prj_02")));
    expect(statusOf(() => getTeamChangesAfterClose(null, "evt_01"))).toBe(401);
    expect(statusOf(() => getTeamChangesAfterClose(member, "evt_01"))).toBe(403);
    expect(statusOf(() => getTeamChangesAfterClose(org(), "evt_01"))).toBeNull();
  });

  it("the public results mark that project's row, and no other", () => {
    renameTeam(org(), teamOf("prj_01"), { name: "Glass Signal Crew", reason: "The team asked by mail; a typo" });
    setJudgeOverride(org(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
    mergeDuplicate(org(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(org(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    publishResults(org(), "evt_01");
    const published = getPublishedResults("evt_01");
    if (!published.published) throw new Error("expected published results");
    const rows = published.tracks.flatMap((t) => t.rows);
    expect(rows.filter((r) => r.teamChangedAt).map((r) => r.projectId)).toEqual(["prj_01"]);
    expect(rows.find((r) => r.projectId === "prj_01")!.teamName).toBe("Glass Signal Crew");
  });
});
