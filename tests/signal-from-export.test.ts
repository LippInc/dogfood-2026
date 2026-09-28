import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { publishResults } from "@/server/dal/results";
import { exportFile } from "@/server/dal/exports";
import { permutationShare, type Obs } from "@/server/judging/normalize";
import type { Actor } from "@/server/authz";

// "Same seed, same share": the signal check the results page publishes is recomputable by
// anyone holding event.json, from the rows in it and the seed stored with the run, by the
// recipe JUDGING.md states. Everything below reads only the exported JSON.

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

function organizer(): Actor {
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, "usr_organizer")).all();
  return { userId: "usr_organizer", name: "Organizer", email: "organizer@example.org", isAdmin: false, roles, sessionKind: "login" };
}

type Exported = {
  event: { settings: { publishedRunId?: string } };
  rubric: { id: string; weight: number }[];
  projects: { id: string; status: string; duplicateOf: string | null }[];
  assignments: { id: string; judgeUserId: string; projectId: string; status: string }[];
  scores: { id: string; assignmentId: string; conflicted: boolean }[];
  scoreItems: { scoreId: string; criterionId: string; value: number }[];
  normalizationRuns: { id: string; params: { excluded: string[]; signal: { share: number; trials: number; seed: number } | null } }[];
};

/**
 * The recipe, from the export alone: finished reviews (every criterion scored, not recused,
 * not conflicted, on a submitted project) in order of score id; one observation per judge
 * and project (a merged copy counts for the copy kept; two reviews of it are averaged), in
 * order of that pair's first review; the run's excluded judges left out.
 */
function observationsFrom(x: Exported, excluded: Set<string>): Obs[] {
  const weight = new Map(x.rubric.map((c) => [c.id, c.weight]));
  const project = new Map(x.projects.filter((p) => p.status === "submitted").map((p) => [p.id, p]));
  const assignment = new Map(x.assignments.map((a) => [a.id, a]));
  const items = new Map<string, Map<string, number>>();
  for (const it of x.scoreItems) {
    if (!weight.has(it.criterionId)) continue;
    const m = items.get(it.scoreId) ?? new Map<string, number>();
    m.set(it.criterionId, it.value);
    items.set(it.scoreId, m);
  }
  const pairs = new Map<string, { judgeId: string; projectId: string; ys: number[] }>();
  for (const s of [...x.scores].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const a = assignment.get(s.assignmentId)!;
    const values = items.get(s.id);
    if (s.conflicted || a.status === "recused" || !values || values.size !== weight.size || !project.has(a.projectId)) continue;
    let sum = 0;
    let w = 0;
    for (const [c, v] of values) {
      sum += weight.get(c)! * v;
      w += weight.get(c)!;
    }
    const projectId = project.get(a.projectId)!.duplicateOf ?? a.projectId;
    const key = `${a.judgeUserId}|${projectId}`;
    const e = pairs.get(key) ?? { judgeId: a.judgeUserId, projectId, ys: [] };
    e.ys.push(sum / w);
    pairs.set(key, e);
  }
  return [...pairs.values()]
    .map((e) => ({ judgeId: e.judgeId, projectId: e.projectId, y: e.ys.reduce((s, y) => s + y, 0) / e.ys.length }))
    .filter((o) => !excluded.has(o.judgeId));
}

describe("the published signal check, reproduced from event.json", () => {
  it("gives the stored share exactly with the stored seed, and another share with another seed (known-bad)", () => {
    const org = organizer();
    mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "one review is all it got" });
    setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "4 / 4 / 4 on every project" });
    publishResults(org, "evt_01");
    const x = JSON.parse(exportFile(org, "evt_01", "event.json").body) as Exported;
    const run = x.normalizationRuns.find((r) => r.id === x.event.settings.publishedRunId)!;
    const signal = run.params.signal!;
    expect(signal.trials).toBe(2000);
    const obs = observationsFrom(x, new Set(run.params.excluded));
    expect(obs.length).toBeGreaterThan(100);
    expect(permutationShare(obs, signal.trials, signal.seed).share).toBe(signal.share);
    // The seed decides the draws: another one lands elsewhere, so the equality above is not a coincidence of the data.
    expect(permutationShare(obs, signal.trials, signal.seed + 1).share).not.toBe(signal.share);
  });
});
