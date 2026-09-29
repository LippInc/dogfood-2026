import "server-only";
import { seededRng } from "./random";

// The judges' decision on a close call (JUDGING.md, "Close calls and the judges' decision").
//
// P(first): each project's chance of really being first in its track, read from the engine's
// own score and ± (one standard error). DRAWS normal draws around every score, from one fixed
// seed per track: the same rows give the same chances on every machine, and one track's
// chances never depend on another track. A track's top is too close to call when the
// ranking's top project is first in fewer than CALL_LINE of the draws.
//
// Nothing here reads the database: the data access layer passes a track's ranked rows in.

/** The line the engine verifier held the rule to: a winner is called at P(first) >= 0.95. */
export const CALL_LINE = 0.95;
export const DRAWS = 4000;
/** The verifier's seed (engine experiment, 2026-09-29), fixed so a close call can be recomputed by anyone. */
export const DRAW_SEED = 20260929;

/** One ranked project of a track: its score and one standard error of it. */
export type Contender = { id: string; score: number; se: number | null };

/** A standard normal draw (Box-Muller, one pair of uniforms per draw), as the verifier draws them. */
function gauss(random: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

/**
 * How many of DRAWS draws put each project first. Projects are drawn in order of id, so the
 * order the rows arrive in changes nothing. Null when a project has no ± (the engine could not
 * measure its noise): a missing ± would read as certainty, and certainty is not in the data.
 */
export function firstCounts(rows: readonly Contender[]): Map<string, number> | null {
  if (rows.some((r) => r.se === null || !Number.isFinite(r.se) || !Number.isFinite(r.score))) return null;
  const ids = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const counts = new Map(ids.map((r) => [r.id, 0]));
  const g = gauss(seededRng(DRAW_SEED));
  for (let d = 0; d < DRAWS; d++) {
    let best: string | null = null;
    let bestX = -Infinity;
    for (const r of ids) {
      const x = r.score + r.se! * g();
      if (best === null || x > bestX) {
        best = r.id;
        bestX = x;
      }
    }
    counts.set(best!, counts.get(best!)! + 1);
  }
  return counts;
}

export type CloseCall = {
  /** the ranking's first place: every project that shares the top score (more than one only on an exact tie) */
  top: string[];
  /** every ranked project's chance of being first, highest first (score, then id, breaks equal chances) */
  chances: { id: string; p: number }[];
  /** the ranking's top is first in at least CALL_LINE of the draws: the scores name the winner */
  callable: boolean;
  /** the fewest projects, highest chance first, that are first in at least CALL_LINE of the draws together: the close projects */
  close: string[];
};

/**
 * The close-call check for one track. Null when there is nothing to call: fewer than two
 * ranked projects, or a project without a ±.
 */
export function closeCall(rows: readonly Contender[]): CloseCall | null {
  if (rows.length < 2) return null;
  const counts = firstCounts(rows);
  if (!counts) return null;
  const best = Math.max(...rows.map((r) => r.score));
  const top = rows.filter((r) => Math.abs(r.score - best) <= 1e-9).map((r) => r.id).sort();
  const scoreOf = new Map(rows.map((r) => [r.id, r.score]));
  const ordered = [...counts]
    .sort(([a, x], [b, y]) => y - x || scoreOf.get(b)! - scoreOf.get(a)! || (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, n]) => ({ id, n }));
  // counts, not fractions: 0.95 of 4,000 draws is exactly 3,800, with no floating-point sum in the way
  const need = Math.ceil(CALL_LINE * DRAWS);
  const topCount = Math.max(...top.map((id) => counts.get(id)!));
  const callable = top.length === 1 && topCount >= need;
  const close: string[] = [];
  let sum = 0;
  for (const c of ordered) {
    close.push(c.id);
    sum += c.n;
    if (sum >= need) break;
  }
  return { top, chances: ordered.map((c) => ({ id: c.id, p: c.n / DRAWS })), callable, close: callable ? [top[0]!] : close };
}

/**
 * A track's published order with the judges' decision: the decided winner first, every other
 * row in the order it came in (the score order). Rows without the winner come back unchanged.
 */
export function withDecidedWinner<T extends { projectId: string }>(rows: readonly T[], winnerId: string): T[] {
  const i = rows.findIndex((r) => r.projectId === winnerId);
  if (i < 0) return [...rows];
  return [rows[i]!, ...rows.slice(0, i), ...rows.slice(i + 1)];
}
