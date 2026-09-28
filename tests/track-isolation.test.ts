import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { assignments, auditLog, events, judgeTracks, projects, teamMembers, userRoles } from "@/server/db/schema";
import { assignByHand } from "@/server/dal/assignments";
import { getJudges, setJudgeTracks } from "@/server/dal/judges";
import { latestAudit } from "@/server/dal/audit-log";
import { updateProject } from "@/server/dal/projects";
import { getJudgeConsole, saveReview } from "@/server/dal/reviews";
import { getJudgeScores } from "@/server/dal/scores";
import { actorForToken, createLoginSession } from "@/server/session";

// T2: "A track judge must never see another track." The assignment run never
// crosses tracks; these tests cover the side doors a judge's-eye review found:
// a judge losing a track, a hand assignment from another track, and a team moving
// its project after judges were assigned. Every refusal has its positive control.

const NOW = "2026-09-27T08:00:00.000Z";
let h: Handle;
const saved = { flag: process.env.SEED_CHECKER_SESSIONS };

function checker(label: "organizer" | "judge_a" | "participant") {
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions disabled in test");
  return actorForToken(h.db, seeded.identities.find((i) => i.label === label)!.token)!;
}

function outcome(fn: () => unknown): { status: number; code?: string } {
  try {
    fn();
    return { status: 200 };
  } catch (err) {
    const e = err as { status?: number; code?: string };
    return { status: e.status ?? 500, code: e.code };
  }
}

const tracksOf = (judge: string) =>
  h.db
    .select({ t: judgeTracks.trackId })
    .from(judgeTracks)
    .where(and(eq(judgeTracks.judgeUserId, judge), eq(judgeTracks.eventId, "evt_01")))
    .all()
    .map((r) => r.t);
const trackOf = (project: string) => h.db.select({ t: projects.trackId }).from(projects).where(eq(projects.id, project)).get()!.t;

beforeEach(() => {
  process.env.SEED_CHECKER_SESSIONS = "true";
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
  process.env.SEED_CHECKER_SESSIONS = saved.flag;
});

describe("a track judge never sees another track", () => {
  it("a judge who loses a track loses its projects: gone from the console and the scores, saves refused; given back, both return", () => {
    const judge = checker("judge_a");
    const org = checker("organizer");
    const item = getJudgeConsole(judge, "evt_01").items[0]!;
    const lost = trackOf(item.project.id);
    const original = tracksOf(judge.userId);
    const others = original.filter((t) => t !== lost);
    const fallback = h.db.select({ t: projects.trackId }).from(projects).all().map((r) => r.t).find((t) => t !== lost)!;
    setJudgeTracks(org, "evt_01", judge.userId, { trackIds: others.length ? others : [fallback] });

    const after = getJudgeConsole(judge, "evt_01");
    expect(after.items.some((i) => i.project.id === item.project.id)).toBe(false);
    expect(after.items.every((i) => trackOf(i.project.id) !== lost)).toBe(true);
    expect(getJudgeScores(judge, null).reviews.some((r) => r.projectId === item.project.id)).toBe(false);
    expect(outcome(() => saveReview(judge, item.assignmentId, { values: {} }))).toEqual({ status: 403, code: "outside_your_tracks" });

    // Positive control: the same judge, the same assignment, the track given back.
    setJudgeTracks(org, "evt_01", judge.userId, { trackIds: original });
    expect(getJudgeConsole(judge, "evt_01").items.some((i) => i.project.id === item.project.id)).toBe(true);
    expect(outcome(() => saveReview(judge, item.assignmentId, { values: {} })).status).toBe(200);
  });

  it("assigning a judge from another track by hand adds that track to the judge, in the same audited action", () => {
    const org = checker("organizer");
    const project = "prj_19";
    const track = trackOf(project);
    const team = h.db.select({ t: projects.teamId }).from(projects).where(eq(projects.id, project)).get()!.t;
    const onTeam = new Set(h.db.select({ u: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, team)).all().map((r) => r.u));
    const assigned = new Set(h.db.select({ j: assignments.judgeUserId }).from(assignments).where(eq(assignments.projectId, project)).all().map((r) => r.j));
    const judges = h.db
      .select({ u: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.eventId, "evt_01"), eq(userRoles.role, "judge")))
      .all()
      .map((r) => r.u);
    const outsider = judges.find((j) => !tracksOf(j).includes(track) && !onTeam.has(j) && !assigned.has(j))!;
    expect(outsider).toBeTruthy();
    expect(tracksOf(outsider)).not.toContain(track);

    assignByHand(org, "evt_01", { projectId: project, judgeUserId: outsider, reason: "cover the under-reviewed project" });

    expect(tracksOf(outsider)).toContain(track);
    const row = h.db.select().from(auditLog).where(eq(auditLog.action, "assignment.by_hand")).orderBy(desc(auditLog.id)).get()!;
    expect(row.after).toMatchObject({ judgeUserId: outsider, inTrack: false, addedTrack: track });
    const outsiderActor = actorForToken(h.db, createLoginSession(h.db, outsider).token)!;
    expect(getJudgeConsole(outsiderActor, "evt_01").items.some((i) => i.project.id === project)).toBe(true);

    // The grant reaches the whole track (later top-ups, pairwise questions), so it is its own row, just before the
    // assignment's: the judge's tracks before and after, and which hand assignment brought it, with the reason.
    const grant = h.db.select().from(auditLog).where(eq(auditLog.action, "judge.tracks")).orderBy(desc(auditLog.id)).get()!;
    expect(grant.targetId).toBe(outsider);
    expect(grant.id).toBe(row.id - 1);
    expect((grant.before as { trackIds: string[] }).trackIds).not.toContain(track);
    expect(grant.after).toMatchObject({ via: "assignment.by_hand", project, reason: "cover the under-reviewed project" });
    expect((grant.after as { trackIds: string[] }).trackIds).toContain(track);
    // the log says it in words, and the judges page says where the track came from
    const trackName = (h.sqlite.prepare("SELECT name FROM tracks WHERE id = ?").get(track) as { name: string }).name;
    const words = latestAudit(h.db, "evt_01", 2, ["judge.tracks", "assignment.by_hand"]).map((l) => l.parts.map((p) => p.text).join(""));
    expect(words[0]).toContain(`which added the track “${trackName}” to theirs`);
    expect(words[1]).toContain(`added “${trackName}” to the tracks of`);
    const shown = getJudges(org, "evt_01").judges.find((j) => j.id === outsider)!.tracks.find((t) => t.id === track)!;
    expect(shown.byHand).toMatchObject({ project: expect.any(String) });
  });

  it("a track taken off and granted again with the tracks form is no longer marked by hand", () => {
    const org = checker("organizer");
    const project = "prj_19";
    const track = trackOf(project);
    const team = h.db.select({ t: projects.teamId }).from(projects).where(eq(projects.id, project)).get()!.t;
    const onTeam = new Set(h.db.select({ u: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, team)).all().map((r) => r.u));
    const assigned = new Set(h.db.select({ j: assignments.judgeUserId }).from(assignments).where(eq(assignments.projectId, project)).all().map((r) => r.j));
    const outsider = h.db
      .select({ u: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.eventId, "evt_01"), eq(userRoles.role, "judge")))
      .all()
      .map((r) => r.u)
      .find((j) => !tracksOf(j).includes(track) && !onTeam.has(j) && !assigned.has(j))!;
    const byHand = () => getJudges(org, "evt_01").judges.find((j) => j.id === outsider)!.tracks.find((t) => t.id === track)?.byHand;
    const own = tracksOf(outsider);

    assignByHand(org, "evt_01", { projectId: project, judgeUserId: outsider, reason: "cover the under-reviewed project" });
    expect(byHand()).toMatchObject({ project: expect.any(String) }); // positive control: the hand grant is marked
    setJudgeTracks(org, "evt_01", outsider, { trackIds: own });
    expect(byHand()).toBeUndefined(); // the track is gone
    setJudgeTracks(org, "evt_01", outsider, { trackIds: [...own, track] });
    expect(byHand()).toBeNull(); // granted again with the tracks form: not by hand
    // and a second hand grant after another removal is marked again
    setJudgeTracks(org, "evt_01", outsider, { trackIds: own });
    const outsiderTeams = new Set(h.db.select({ t: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, outsider)).all().map((r) => r.t));
    const another = h.db
      .select({ id: projects.id, teamId: projects.teamId })
      .from(projects)
      .where(and(eq(projects.eventId, "evt_01"), eq(projects.trackId, track)))
      .all()
      .find((p) => p.id !== project && !outsiderTeams.has(p.teamId))!;
    assignByHand(org, "evt_01", { projectId: another.id, judgeUserId: outsider, reason: "cover another one" });
    expect(byHand()).toMatchObject({ project: expect.any(String) });
  });

  it("a hand assignment within the judge's own track grants nothing and writes no track row (positive control)", () => {
    const org = checker("organizer");
    const project = "prj_19";
    const track = trackOf(project);
    const assigned = new Set(h.db.select({ j: assignments.judgeUserId }).from(assignments).where(eq(assignments.projectId, project)).all().map((r) => r.j));
    const team = h.db.select({ t: projects.teamId }).from(projects).where(eq(projects.id, project)).get()!.t;
    const onTeam = new Set(h.db.select({ u: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, team)).all().map((r) => r.u));
    const free = (j: string) => !assigned.has(j) && !onTeam.has(j);
    let judge = h.db
      .select({ u: judgeTracks.judgeUserId })
      .from(judgeTracks)
      .where(eq(judgeTracks.trackId, track))
      .all()
      .map((r) => r.u)
      .find(free);
    if (!judge) {
      // every judge of the track already has the project: give one more judge the track first, with the tracks form
      judge = h.db
        .select({ u: userRoles.userId })
        .from(userRoles)
        .where(and(eq(userRoles.eventId, "evt_01"), eq(userRoles.role, "judge")))
        .all()
        .map((r) => r.u)
        .find(free)!;
      setJudgeTracks(org, "evt_01", judge, { trackIds: [...tracksOf(judge), track] });
    }
    const rows = () => h.db.select().from(auditLog).where(eq(auditLog.action, "judge.tracks")).all().length;
    const before = rows();
    assignByHand(org, "evt_01", { projectId: project, judgeUserId: judge, reason: "same track, one more review" });
    expect(rows()).toBe(before);
    expect(getJudges(org, "evt_01").judges.find((j) => j.id === judge)!.tracks.find((t) => t.id === track)!.byHand).toBeNull();
  });

  it("once judges are assigned, the team cannot move its project to another track; other edits still work, and with every assignment recused the move does", () => {
    h.db.update(events).set({ submissionsCloseAt: "2099-01-01T00:00:00.000Z" }).where(eq(events.id, "evt_01")).run();
    const participant = checker("participant");
    const p = h.db.select().from(projects).where(eq(projects.id, "prj_01")).get()!;
    const other = h.db.select({ t: projects.trackId }).from(projects).all().map((r) => r.t).find((t) => t !== p.trackId)!;
    const body = (trackId: string, title = p.title) => ({
      title,
      summary: p.summary,
      description: p.description,
      trackId,
      repoUrl: p.repoUrl ?? "",
      videoUrl: p.videoUrl ?? "",
      liveUrl: p.liveUrl ?? "",
      status: "submitted",
    });

    expect(outcome(() => updateProject(participant, "prj_01", body(other)))).toEqual({ status: 409, code: "track_locked" });
    expect(trackOf("prj_01")).toBe(p.trackId);
    expect(outcome(() => updateProject(participant, "prj_01", body(p.trackId, `${p.title} (v2)`))).status).toBe(200);

    h.db.update(assignments).set({ status: "recused" }).where(eq(assignments.projectId, "prj_01")).run();
    expect(outcome(() => updateProject(participant, "prj_01", body(other))).status).toBe(200);
    expect(trackOf("prj_01")).toBe(other);
  });
});
