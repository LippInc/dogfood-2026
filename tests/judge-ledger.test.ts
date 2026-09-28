import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { requireEvent } from "@/server/dal/events";
import { computeNormalization, KEPT_MIN_TILT, type Normalized } from "@/server/dal/normalization";
import {
  acceptUnderReviewed,
  mergeDuplicate,
  revokeJudgeOverride,
  setJudgeOverride,
} from "@/server/dal/decisions";
import { getNormalization, getPublishedResults, publishResults } from "@/server/dal/results";
import type { Actor } from "@/server/authz";

// The judge ledger on the fixture: each judge's leniency ± its standard error, the
// reviews counted, and the single-judge influence check, which must predict exactly
// what the matching override then does to the ranking.

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

/**
 * What an override did, measured independently of the check: projects ranked in both
 * runs whose normalized rank differs by a place or more, those left unranked, the
 * size of the largest move, and the tracks whose first place changed.
 */
function compare(before: Normalized, after: Normalized) {
  const rankAfter = new Map(after.projects.map((p) => [p.id, p.rankNormalized]));
  let moved = 0;
  let unranked = 0;
  let largest = 0;
  for (const p of before.projects) {
    if (p.rankNormalized === null) continue;
    const to = rankAfter.get(p.id) ?? null;
    if (to === null) unranked++;
    else if (Math.abs(to - p.rankNormalized) >= 1) {
      moved++;
      largest = Math.max(largest, Math.abs(to - p.rankNormalized));
    }
  }
  const firsts = (n: Normalized) => {
    const best = new Map<string, number>();
    for (const p of n.projects) if (p.trackRank !== null) best.set(p.trackId, Math.min(best.get(p.trackId) ?? Infinity, p.trackRank));
    const out = new Map<string, string>();
    for (const [track, rank] of best)
      out.set(
        track,
        n.projects
          .filter((p) => p.trackId === track && p.trackRank === rank)
          .map((p) => p.id)
          .sort()
          .join("|"),
      );
    return out;
  };
  const a = firsts(before);
  const b = firsts(after);
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter((t) => a.get(t) !== b.get(t)).sort();
  return { moved, unranked, largest, changed };
}

describe("the judge ledger", () => {
  it("gives every counted judge a leniency ± and leaves the flat judge's out", () => {
    const n = getNormalization(organizer(), "evt_01").normalization;
    const flat = n.judges.find((j) => j.id === "jdg_07")!;
    expect(flat).toMatchObject({ excluded: true, n: 0, nAll: 3, se: null });
    const counted = n.judges.filter((j) => !j.excluded && j.n > 0);
    expect(counted.length).toBeGreaterThan(10);
    for (const j of counted) {
      expect(j.se).not.toBeNull();
      // a leniency known from n reviews is never surer than σ̂² ÷ (n + k) allows
      expect(j.se!).toBeGreaterThanOrEqual(Math.sqrt(n.variance.sigma2 / (j.n + n.variance.k!)) - 1e-12);
      expect(j.nAll).toBe(j.n);
    }
  });

  it("its tilt kept agrees with the same row: tilt × kept = leniency, blank under a tilt of 0.05 (known-bad: the nominal n ÷ (n + k) does not)", () => {
    const n = getNormalization(organizer(), "evt_01").normalization;
    const counted = n.judges.filter((j) => !j.excluded && j.n > 0);
    const shown = counted.filter((j) => j.kept !== null);
    expect(shown.length).toBeGreaterThan(20);
    for (const j of shown) expect(Math.abs(j.tilt! * j.kept! - j.leniency)).toBeLessThan(1e-12);
    for (const j of counted.filter((x) => x.kept === null)) expect(j.tilt === null || Math.abs(j.tilt) < KEPT_MIN_TILT).toBe(true);
    expect(n.judges.find((j) => j.id === "jdg_07")!.kept).toBeNull();
    // The number the ledger used to show: on the sample event it is off by far more than rounding for some judge.
    expect(Math.max(...shown.map((j) => Math.abs(j.tilt! * j.shrink - j.leniency)))).toBeGreaterThan(0.01);
  });

  it("gives every ranked project a ± at least √(σ̂² ÷ n)", () => {
    const n = getNormalization(organizer(), "evt_01").normalization;
    const ranked = n.projects.filter((p) => p.score !== null);
    expect(ranked).toHaveLength(n.ranked);
    for (const p of ranked) expect(p.se!).toBeGreaterThanOrEqual(Math.sqrt(n.variance.sigma2 / p.n) - 1e-12);
    for (const p of n.projects.filter((q) => q.score === null)) expect(p.se).toBeNull();
  });

  it("the influence check predicts what each override then does, judge by judge", { timeout: 20_000 }, () => {
    const org = organizer();
    const before = getNormalization(org, "evt_01").normalization;
    const checked = before.judges.filter((j) => j.influence);
    expect(checked.length).toBe(before.judges.filter((j) => j.nAll > 0).length);
    for (const j of checked) {
      const mode = j.influence!.change === "leave_out" ? "exclude" : "include";
      expect(mode).toBe(j.excluded ? "include" : "exclude");
      setJudgeOverride(org, "evt_01", { judgeUserId: j.id, mode, reason: "influence check test" });
      const after = computeNormalization(h.db, requireEvent(h.db, "evt_01"));
      const inf = j.influence!;
      expect(compare(before, after), j.id).toEqual({
        moved: inf.moved,
        unranked: inf.unranked,
        largest: inf.biggest ? Math.abs(inf.biggest.to - inf.biggest.from) : 0,
        changed: inf.leaders.map((l) => l.trackId).sort(),
      });
      revokeJudgeOverride(org, "evt_01", { judgeUserId: j.id });
    }
    // not vacuous: some judge's reviews do move the ranking
    expect(Math.max(...checked.map((j) => j.influence!.moved))).toBeGreaterThan(0);
    const flat = checked.find((j) => j.id === "jdg_07")!;
    expect(flat.influence!.change).toBe("reinstate");
  });

  it("the fixture's influence summary, as JUDGING.md states it", () => {
    const n = getNormalization(organizer(), "evt_01").normalization;
    const out = n.judges.filter((j) => j.influence?.change === "leave_out").map((j) => j.influence!);
    const moves = out.map((i) => i.moved).sort((a, b) => a - b);
    const firsts = out.filter((i) => i.leaders.length).length;
    const scoreSe = [...new Set(n.projects.filter((p) => p.se !== null).map((p) => `${p.n}:${p.se!.toFixed(2)}`))].sort();
    const judgeSe = n.judges.filter((j) => j.se !== null).map((j) => j.se!);
    console.log(
      `influence: ${out.length} counted judges; moves ${moves[0]} to ${moves[moves.length - 1]}, median ${moves[(moves.length - 1) >> 1]}/${moves[moves.length >> 1]}; first place changes for ${firsts}; score ± by review count ${scoreSe.join(" ")}; leniency ± ${Math.min(...judgeSe).toFixed(3)} to ${Math.max(...judgeSe).toFixed(3)}; largest |leniency| ${Math.max(...n.judges.filter((j) => j.se !== null).map((j) => Math.abs(j.leniency))).toFixed(3)}`,
    );
    expect(out).toHaveLength(29);
    expect([moves[0], moves[14], moves[28]]).toEqual([3, 20, 34]);
    expect(firsts).toBe(11);
    expect(scoreSe).toEqual(["1:0.66", "2:0.47", "3:0.38", "4:0.33", "5:0.30"]);
  });

  it("shows the organizer each judge's private note on the project's receipt; a merged copy's note moves to the copy kept", () => {
    const pick = (project: string) =>
      h.sqlite
        .prepare("SELECT s.id AS id, a.judge_user_id AS judge FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE a.project_id = ? LIMIT 1")
        .get(project) as { id: string; judge: string };
    const write = (scoreId: string, note: string) =>
      h.sqlite
        .prepare("INSERT INTO score_comments (score_id, feedback, private_note) VALUES (?, '', ?) ON CONFLICT(score_id) DO UPDATE SET private_note = excluded.private_note")
        .run(scoreId, note);
    const a = pick("prj_03");
    const b = pick("prj_07");
    write(a.id, "Demo crashed twice; scored the design doc.");
    write(b.id, "Same repository as prj_41.");
    let notes = getNormalization(organizer(), "evt_01").notes;
    expect(notes.map((x) => [x.projectId, x.judgeId, x.note])).toEqual(
      expect.arrayContaining([
        ["prj_03", a.judge, "Demo crashed twice; scored the design doc."],
        ["prj_07", b.judge, "Same repository as prj_41."],
      ]),
    );
    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_41", duplicateId: "prj_07" });
    notes = getNormalization(organizer(), "evt_01").notes;
    expect(notes.find((x) => x.note === "Same repository as prj_41.")?.projectId).toBe("prj_41");
  });

  it("publishing stores each score's ± with the run, and the public results carry exactly the ± the organizer saw", () => {
    const org = organizer();
    setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
    mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    const preview = new Map(getNormalization(org, "evt_01").normalization.projects.map((p) => [p.id, p.se]));
    publishResults(org, "evt_01");
    const published = getPublishedResults("evt_01");
    if (!published.published) throw new Error("expected published results");
    const rows = published.tracks.flatMap((t) => t.rows);
    expect(rows.length).toBe(40);
    for (const r of rows) {
      expect(r.se, r.projectId).not.toBeNull();
      expect(r.se).toBeCloseTo(preview.get(r.projectId)!, 12);
    }
  });

  it("the duplicate's ranks and the leniency range, as JUDGING.md states them", () => {
    const org = organizer();
    const before = getNormalization(org, "evt_01").normalization;
    const raw = (n: Normalized, id: string) => n.projects.find((p) => p.id === id)!.rankRaw;
    const lenient = before.judges.filter((j) => j.se !== null);
    const largest = Math.max(...lenient.map((j) => Math.abs(j.leniency)));
    const seRange = [Math.min(...lenient.map((j) => j.se!)), Math.max(...lenient.map((j) => j.se!))];
    mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    const merged = computeNormalization(h.db, requireEvent(h.db, "evt_01"));
    const kept = merged.projects.find((p) => p.id === "prj_07")!;
    expect([raw(before, "prj_07"), raw(before, "prj_41"), before.ranked]).toEqual([31.5, 9, 41]);
    expect([kept.rankRaw, kept.rankNormalized, merged.ranked]).toEqual([25.5, 22, 40]);
    expect(largest).toBeCloseTo(0.062, 3);
    expect(seRange.map((x) => Number(x.toFixed(3)))).toEqual([0.093, 0.099]);
  });

  it("known-bad: comparing a run with itself finds nothing to predict", () => {
    const n = computeNormalization(h.db, requireEvent(h.db, "evt_01"));
    expect(compare(n, n)).toEqual({ moved: 0, unranked: 0, largest: 0, changed: [] });
  });
});
