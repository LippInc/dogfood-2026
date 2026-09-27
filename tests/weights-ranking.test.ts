import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import type { Actor } from "@/server/authz";
import { saveRubric } from "@/server/dal/organize";
import { getNormalization } from "@/server/dal/normalization";

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
const organizer = () => actorById("usr_organizer");

/** Ranks 1..n; tied values get the average of the ranks they share. */
function averageRanks(a: number[]): number[] {
  const order = a.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
  const ranks = new Array<number>(a.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]!.i] = r;
    i = j + 1;
  }
  return ranks;
}

/** Spearman: Pearson correlation of the average-rank vectors. */
function spearman(a: number[], b: number[]): number {
  const ra = averageRanks(a);
  const rb = averageRanks(b);
  const ma = ra.reduce((s, v) => s + v, 0) / ra.length;
  const mb = rb.reduce((s, v) => s + v, 0) / rb.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    const x = ra[i]! - ma;
    const y = rb[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db);
}

describe("unequal rubric weights change the ranking", () => {
  it("weights steer the ranking: all weight on one criterion ranks by that criterion, and moving it changes the order", { timeout: 30_000 }, () => {
    const criteria = h.sqlite
      .prepare("SELECT id, key, label, prompt, weight FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY position")
      .all() as { id: string; key: string; label: string; prompt: string; weight: number }[];
    expect(criteria.length).toBeGreaterThanOrEqual(2);

    const meanRows = h.sqlite
      .prepare(
        `SELECT a.project_id AS project, rc.key AS key, avg(si.value) AS mean
         FROM score_items si
         JOIN scores s ON s.id = si.score_id
         JOIN assignments a ON a.id = s.assignment_id
         JOIN rubric_criteria rc ON rc.id = si.criterion_id
         WHERE a.event_id = 'evt_01'
         GROUP BY a.project_id, rc.key`,
      )
      .all() as { project: string; key: string; mean: number }[];
    const means = new Map<string, Map<string, number>>();
    for (const r of meanRows) {
      if (!means.has(r.project)) means.set(r.project, new Map());
      means.get(r.project)!.set(r.key, r.mean);
    }

    // X and Y: the pair of criteria whose per-project means correlate least (NaN from a
    // degenerate vector loses to everything, so such pairs are simply skipped).
    const keys = criteria.map((c) => c.key);
    let best = { rho: Infinity, x: "", y: "" };
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const x = keys[i]!;
        const y = keys[j]!;
        const shared = [...means.keys()].filter((p) => means.get(p)!.has(x) && means.get(p)!.has(y)).sort();
        const rho = spearman(
          shared.map((p) => means.get(p)!.get(x)!),
          shared.map((p) => means.get(p)!.get(y)!),
        );
        if (rho < best.rho) best = { rho, x, y };
      }
    }
    expect(Number.isFinite(best.rho)).toBe(true);
    const { x: X, y: Y } = best;

    // Rewrite the rubric with all weight on one criterion, then read the engine's scores.
    function heavy(key: string): { id: string; score: number }[] {
      saveRubric(
        organizer(),
        "evt_01",
        criteria.map((c) => ({ id: c.id, label: c.label, prompt: c.prompt, weight: c.key === key ? 50 : 1 })),
      );
      return getNormalization(organizer(), "evt_01").normalization.projects
        .filter((p) => p.score !== null && means.get(p.id)?.has(X) && means.get(p.id)?.has(Y))
        .map((p) => ({ id: p.id, score: p.score! }));
    }
    const meanOf = (rows: { id: string }[], key: string) => rows.map((r) => means.get(r.id)!.get(key)!);

    const underX = heavy(X);
    const underY = heavy(Y);

    expect(spearman(underX.map((r) => r.score), meanOf(underX, X))).toBeGreaterThan(
      spearman(underX.map((r) => r.score), meanOf(underX, Y)),
    );
    expect(spearman(underY.map((r) => r.score), meanOf(underY, Y))).toBeGreaterThan(
      spearman(underY.map((r) => r.score), meanOf(underY, X)),
    );

    // score descending, ties by id: the two weightings must not order the projects alike
    const order = (rows: { id: string; score: number }[]) =>
      [...rows].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((r) => r.id);
    expect(order(underX)).not.toEqual(order(underY));
  });

  it("spearman: 1 on identical input, -1 on a reversed array, 0.8 on one swapped pair", () => {
    expect(spearman([3, 1, 4, 2], [3, 1, 4, 2])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 2, 3, 4], [1, 2, 4, 3])).toBeCloseTo(0.8);
  });
});
