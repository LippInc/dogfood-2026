import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportFile } from "@/server/dal/exports";
import { getMyWork } from "@/server/dal/projects";
import { getNormalization, getPublishedResults, publishResults } from "@/server/dal/results";
import { setTieBreak } from "@/server/dal/tiebreak";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { actorById, organizer, sqlAll, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// A three-way exact score tie the criterion splits 4, 4, 1 (the review's Small Loom, Small Relay and a third): the
// first two stay joint, only the third's place is decided by the criterion. The fixture's prj_31, prj_32 and prj_33
// (one track) are reviewed by the same three judges; giving each the same review per judge, with the criteria arranged
// so the totals match and functionality reads 4, 4, 1, plants that tie.

withFixtureEvent();

const crit = (key: string) => sqlGet<{ id: string }>("SELECT id FROM rubric_criteria WHERE event_id = 'evt_01' AND key = ?", key)!.id;

function plantThreeWayTie() {
  sqlRun("UPDATE rubric_criteria SET weight = 1 WHERE event_id = 'evt_01'");
  const values: Record<string, Record<string, number>> = {
    prj_31: { functionality: 4, quality: 2, innovation: 3 },
    prj_32: { functionality: 4, quality: 3, innovation: 2 },
    prj_33: { functionality: 1, quality: 4, innovation: 4 },
  };
  for (const [project, byKey] of Object.entries(values)) {
    const items = sqlAll<{ scoreId: string; key: string }>(
      "SELECT s.id AS scoreId, c.key AS key FROM assignments a JOIN scores s ON s.assignment_id = a.id JOIN score_items si ON si.score_id = s.id JOIN rubric_criteria c ON c.id = si.criterion_id WHERE a.project_id = ?",
      project,
    );
    expect(items.length).toBeGreaterThanOrEqual(9);
    for (const it of items) sqlRun("UPDATE score_items SET value = ? WHERE score_id = ? AND criterion_id = ?", byKey[it.key]!, it.scoreId, crit(it.key));
  }
}

const csvCols = (csv: string, id: string) => {
  const lines = csv.split(/\r?\n/);
  const head = lines[0]!.split(",");
  const line = lines.find((l) => l.startsWith(`${id},`))!;
  const cells = line.split(",");
  // the three tie columns are the last three, and none of their cells holds a comma
  return { head: head.slice(-3), cells: cells.slice(-3) };
};

describe("a three-way tie the criterion splits 4, 4, 1", () => {
  it("normalized.csv before publishing names the criterion only beside the place it decided, as after publishing", () => {
    plantThreeWayTie();
    const live = getNormalization(organizer(), "evt_01").normalization.projects;
    const score = (id: string) => live.find((p) => p.id === id)!.score!;
    expect(Math.abs(score("prj_31") - score("prj_32"))).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(score("prj_31") - score("prj_33"))).toBeLessThanOrEqual(1e-9);

    setTieBreak(organizer(), "evt_01", { criterionId: crit("functionality"), reason: "Announced to teams at kickoff" });
    const view = getNormalization(organizer(), "evt_01").tieBreak!;
    const group = view.groups.find((g) => g.projects.some((p) => p.id === "prj_31"))!;
    expect(group.projects.map((p) => p.id).sort()).toEqual(["prj_31", "prj_32", "prj_33"]);
    // the raw flag is true for all three: the criterion moved every one of them
    expect(group.projects.map((p) => p.broken)).toEqual([true, true, true]);

    const before = exportFile(organizer(), "evt_01", "normalized.csv").body;
    const label = csvCols(before, "prj_33");
    expect(label.head).toEqual(["tie_break_figure", "track_place", "tie_broken_by"]);
    const crName = sqlGet<{ label: string }>("SELECT label FROM rubric_criteria WHERE id = ?", crit("functionality"))!.label;
    expect(csvCols(before, "prj_31").cells[2]).toBe("");
    expect(csvCols(before, "prj_32").cells[2]).toBe("");
    expect(csvCols(before, "prj_33").cells[2]).toBe(crName);
    expect(csvCols(before, "prj_31").cells[0]).toBe("4.0000");
    expect(csvCols(before, "prj_33").cells[0]).toBe("1.0000");

    // after publishing, the column means the same thing
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    publishResults(organizer(), "evt_01");
    const after = exportFile(organizer(), "evt_01", "normalized.csv").body;
    for (const id of ["prj_31", "prj_32", "prj_33"]) expect(csvCols(after, id).cells[2], id).toBe(csvCols(before, id).cells[2]);

    // D: the team's own My project page gets the place as the public pages show it: joint 1st-style, never 1.5
    const r = getPublishedResults("evt_01");
    if (!r.published) throw new Error("not published");
    const row = r.tracks.flatMap((t) => t.rows).find((x) => x.projectId === "prj_31")!;
    expect(Number.isInteger(row.place)).toBe(false); // the published answer's average place, e.g. 1.5
    const member = sqlGet<{ id: string }>("SELECT tm.user_id AS id FROM team_members tm JOIN projects p ON p.team_id = tm.team_id WHERE p.id = 'prj_31' LIMIT 1")!;
    const mine = getMyWork(actorById(member.id), "evt_01").feedback!;
    expect(mine.standing).toEqual({ place: Math.floor(row.place!), joint: true });
    expect(mine.tieBrokenBy).toBeUndefined();
    const third = sqlGet<{ id: string }>("SELECT tm.user_id AS id FROM team_members tm JOIN projects p ON p.team_id = tm.team_id WHERE p.id = 'prj_33' LIMIT 1")!;
    const theirs = getMyWork(actorById(third.id), "evt_01").feedback!;
    expect(theirs.standing).toEqual({ place: Math.floor(row.place!) + 2, joint: false });
    expect(theirs.tieBrokenBy).toBe(crName);
  });

  it("the My project page draws the shared place as \"Joint 1st\", and the record page and /verify never say \"tie broken by\" beside a joint place", () => {
    const my = fs.readFileSync(path.join(process.cwd(), "src/app/events/[event]/my-project/page.tsx"), "utf8");
    expect(my).toContain("feedback.standing.joint ? `Joint ${ordinal(feedback.standing.place)}` : \"Place\"");
    expect(my).not.toContain("{feedback.place}");
    for (const f of ["src/app/records/[record]/page.tsx", "src/app/verify/verify-form.tsx"]) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src, f).toContain("p?.tieBrokenBy && !p.joint ?");
    }
  });
});
