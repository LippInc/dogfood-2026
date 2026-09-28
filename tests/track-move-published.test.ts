import { describe, expect, it } from "vitest";
import { runAssignment } from "@/server/dal/assignments";
import { moveProjectTrack } from "@/server/dal/corrections";
import { acceptUnderReviewed, eventDecisions, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { requireEvent } from "@/server/dal/events";
import { setJudgingMode } from "@/server/dal/pairwise";
import { getPublishedResults, publishResults } from "@/server/dal/results";
import { getDb } from "@/server/db/client";
import { organizer, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// Results are grouped by track, so moving a strong project out of a track just before publishing
// can change that track's winner. Before this the published run and the public results kept no
// trace of the move; now the run stores every move (from, to, reason, when), like the overrides,
// and the public results carry it next to the project.

withFixtureEvent();

function settleAndPublish() {
  const event = requireEvent(getDb(), "evt_01");
  for (const d of eventDecisions(getDb(), event)) {
    if (d.resolved) continue;
    if (d.kind === "flat_judge" || d.kind === "coin_flip_judge") setJudgeOverride(organizer(), "evt_01", { judgeUserId: d.judgeId, mode: "exclude", reason: "Checked, left out" });
    else if (d.kind === "duplicate") mergeDuplicate(organizer(), "evt_01", { keepId: d.copies[0]!.id, duplicateId: d.copies[1]!.id });
    else if (d.kind === "under_reviewed") acceptUnderReviewed(organizer(), "evt_01", { projectId: d.projectId, reason: "Publish with what it has" });
  }
  return publishResults(organizer(), "evt_01");
}

/** A submitted, kept project with finished reviews, and the first other track. */
function pick() {
  const project = sqlGet<{ id: string; track: string }>(
    `SELECT p.id, p.track_id AS track FROM projects p
      WHERE p.event_id = 'evt_01' AND p.status = 'submitted' AND p.duplicate_of IS NULL
        AND EXISTS (SELECT 1 FROM assignments a WHERE a.project_id = p.id AND a.status = 'done')
      ORDER BY p.id LIMIT 1`,
  )!;
  const to = sqlGet<{ id: string; name: string }>("SELECT id, name FROM tracks WHERE event_id = 'evt_01' AND id <> ? ORDER BY position LIMIT 1", project.track)!;
  const from = sqlGet<{ name: string }>("SELECT name FROM tracks WHERE id = ?", project.track)!;
  return { project: project.id, fromId: project.track, from: from.name, toId: to.id, to: to.name };
}

describe("a track move shows on the published results", () => {
  it("control: without a move the published results list none", () => {
    settleAndPublish();
    const r = getPublishedResults("evt_01");
    expect(r.published && r.trackMoves).toEqual([]);
  });

  it("scores mode: the run stores the move and the public results carry it, with the reason and the date", () => {
    runAssignment(organizer(), "evt_01", { mode: "topup", seed: 42 });
    const m = pick();
    moveProjectTrack(organizer(), "evt_01", m.project, { trackId: m.toId, reason: "The team entered the wrong track" });
    const at = sqlGet<{ at: string }>("SELECT at FROM audit_log WHERE action = 'project.track_moved' ORDER BY id DESC LIMIT 1")!.at;
    const { runId } = settleAndPublish();

    const move = { projectId: m.project, fromTrackId: m.fromId, fromTrack: m.from, toTrackId: m.toId, toTrack: m.to, reason: "The team entered the wrong track", at };
    const params = JSON.parse(sqlGet<{ params: string }>("SELECT params FROM normalization_runs WHERE id = ?", runId)!.params);
    expect(params.trackMoves).toEqual([move]);

    const r = getPublishedResults("evt_01");
    if (!r.published) throw new Error("not published");
    expect(r.trackMoves).toEqual([move]);
    // the project sits in its new track's rows
    expect(r.tracks.find((t) => t.id === m.toId)!.rows.some((row) => row.projectId === m.project)).toBe(true);

    // the published record keeps the names as they were when it was published
    sqlRun("UPDATE tracks SET name = 'Renamed later' WHERE id = ?", m.fromId);
    const again = getPublishedResults("evt_01");
    expect(again.published && again.trackMoves[0]!.fromTrack).toBe(m.from);
  });

  it("pairwise mode: the published run stores the move too", () => {
    setJudgingMode(organizer(), "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
    const m = pick();
    moveProjectTrack(organizer(), "evt_01", m.project, { trackId: m.toId, reason: "Belongs in the other track" });
    settleAndPublish();
    const r = getPublishedResults("evt_01");
    if (!r.published) throw new Error("not published");
    expect(r.trackMoves).toEqual([expect.objectContaining({ projectId: m.project, fromTrack: m.from, toTrack: m.to, reason: "Belongs in the other track" })]);
  });

  it("a project moved and moved back shows both moves, oldest first", () => {
    const m = pick();
    moveProjectTrack(organizer(), "evt_01", m.project, { trackId: m.toId, reason: "first thought" });
    moveProjectTrack(organizer(), "evt_01", m.project, { trackId: m.fromId, reason: "back where it was" });
    settleAndPublish();
    const r = getPublishedResults("evt_01");
    if (!r.published) throw new Error("not published");
    expect(r.trackMoves.map((x) => [x.fromTrackId, x.toTrackId, x.reason])).toEqual([
      [m.fromId, m.toId, "first thought"],
      [m.toId, m.fromId, "back where it was"],
    ]);
  });
});
