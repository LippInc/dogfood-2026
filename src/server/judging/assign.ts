import "server-only";
import { pick, seededRng, shuffle } from "./random";

// Judge assignment (BUILD-PLAN decision 12). Pure: the caller loads projects,
// judges, conflicts and the pairs that already exist, and stores what comes back.
//
// Fresh runs start with a bridge pre-pass: every judge with two or more tracks gets
// `bridgePerTrack` projects in each of those tracks (fewest seats filled first), so
// tracks can later be compared through judges who scored in both. Then the greedy:
// the most constrained open project first (fewest spare eligible judges), and its
// least-loaded eligible judge. Top-up runs keep every existing pair and fill only
// the missing seats. Ties are broken by a seeded random draw, never by input order.
// Projects are never assigned across tracks: a project with fewer than two eligible
// judges in its own track is flagged under-reviewed for an organizer's decision.

export type AssignMode = "fresh" | "topup";

export type AssignParams = {
  mode: AssignMode;
  seed: number;
  reviewsPerProject: number;
  bridgePerTrack: number;
  maxPerJudge: number | null;
};

export type AssignInput = AssignParams & {
  projects: { id: string; trackId: string }[];
  judges: { id: string; trackIds: string[] }[];
  /** pairs that may never be assigned: the judge is on the project's team, or recused */
  conflicts: { judgeId: string; projectId: string }[];
  /** pairs that exist already; counts: false for pairs that do not fill a seat (an excluded judge's) */
  existing: { judgeId: string; projectId: string; counts: boolean }[];
  /** judges left out of this run (the flat-judge rule or an organizer's override) */
  excludedJudges: string[];
};

export type AssignedPair = { judgeId: string; projectId: string; via: "bridge" | "greedy" };

export type AssignResult = {
  pairs: AssignedPair[];
  /** each judge's new projects in their seeded review order */
  order: Record<string, string[]>;
  /** fewer than two eligible judges in the project's own track */
  underReviewed: { projectId: string; eligible: number }[];
  /** below the target number of reviews when the run ended */
  short: { projectId: string; reviews: number; target: number }[];
  /** every judge's assignments after the run, existing ones included */
  loads: Record<string, number>;
  bridge: { judgeId: string; trackId: string; got: number; wanted: number }[];
};

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const pairKey = (judgeId: string, projectId: string) => `${judgeId}\u0000${projectId}`;

export function assignJudges(input: AssignInput): AssignResult {
  const random = seededRng(input.seed);
  const target = input.reviewsPerProject;
  const cap = input.maxPerJudge ?? Number.POSITIVE_INFINITY;
  const excluded = new Set(input.excludedJudges);

  // Sorted copies: the result depends on the seed and the data, never on row order.
  const projects = [...input.projects].sort(byId);
  const judges = input.judges
    .filter((j) => !excluded.has(j.id))
    .map((j) => ({ id: j.id, trackIds: [...new Set(j.trackIds)].sort() }))
    .sort(byId);

  const blocked = new Set(input.conflicts.map((c) => pairKey(c.judgeId, c.projectId)));
  const taken = new Set<string>();
  const filled = new Map<string, number>(projects.map((p) => [p.id, 0]));
  const load = new Map<string, number>(judges.map((j) => [j.id, 0]));
  for (const e of input.existing) {
    taken.add(pairKey(e.judgeId, e.projectId));
    if (load.has(e.judgeId)) load.set(e.judgeId, load.get(e.judgeId)! + 1);
    if (e.counts && filled.has(e.projectId)) filled.set(e.projectId, filled.get(e.projectId)! + 1);
  }

  // Eligible: in the project's track and not conflicted. Fixed for the whole run.
  const eligible = new Map<string, string[]>(
    projects.map((p) => [
      p.id,
      judges.filter((j) => j.trackIds.includes(p.trackId) && !blocked.has(pairKey(j.id, p.id))).map((j) => j.id),
    ]),
  );
  const canTake = (judgeId: string, projectId: string) =>
    !taken.has(pairKey(judgeId, projectId)) && load.get(judgeId)! < cap;

  const pairs: AssignedPair[] = [];
  const give = (judgeId: string, projectId: string, via: AssignedPair["via"]) => {
    taken.add(pairKey(judgeId, projectId));
    load.set(judgeId, load.get(judgeId)! + 1);
    filled.set(projectId, filled.get(projectId)! + 1);
    pairs.push({ judgeId, projectId, via });
  };

  // 1. Bridge pre-pass, fresh runs only: round by round, so every bridge judge gets
  // its first project in each track before anyone gets a second.
  const bridge: AssignResult["bridge"] = [];
  if (input.mode === "fresh" && input.bridgePerTrack > 0) {
    const bridgeJudges = shuffle(
      judges.filter((j) => j.trackIds.length >= 2),
      random,
    );
    const got = new Map<string, number>();
    for (let round = 0; round < input.bridgePerTrack; round++) {
      for (const j of bridgeJudges) {
        for (const trackId of j.trackIds) {
          if (load.get(j.id)! >= cap) continue;
          const options = projects.filter(
            (p) =>
              p.trackId === trackId &&
              filled.get(p.id)! < target &&
              eligible.get(p.id)!.includes(j.id) &&
              canTake(j.id, p.id),
          );
          if (options.length === 0) continue;
          const fewest = Math.min(...options.map((p) => filled.get(p.id)!));
          const chosen = pick(
            options.filter((p) => filled.get(p.id) === fewest),
            random,
          );
          give(j.id, chosen.id, "bridge");
          got.set(pairKey(j.id, trackId), (got.get(pairKey(j.id, trackId)) ?? 0) + 1);
        }
      }
    }
    for (const j of [...bridgeJudges].sort(byId)) {
      for (const trackId of j.trackIds) {
        bridge.push({ judgeId: j.id, trackId, got: got.get(pairKey(j.id, trackId)) ?? 0, wanted: input.bridgePerTrack });
      }
    }
  }

  // 2. Greedy: most constrained open project first, then its least-loaded judge.
  for (;;) {
    const open = projects
      .filter((p) => filled.get(p.id)! < target)
      .map((p) => {
        const available = eligible.get(p.id)!.filter((j) => canTake(j, p.id));
        const needed = target - filled.get(p.id)!;
        return { project: p, available, slack: available.length - needed, have: filled.get(p.id)! };
      })
      .filter((c) => c.available.length > 0);
    if (open.length === 0) break;
    const leastSlack = Math.min(...open.map((c) => c.slack));
    const tight = open.filter((c) => c.slack === leastSlack);
    const fewest = Math.min(...tight.map((c) => c.have));
    const next = pick(
      tight.filter((c) => c.have === fewest),
      random,
    );
    const lightest = Math.min(...next.available.map((j) => load.get(j)!));
    const judgeId = pick(
      next.available.filter((j) => load.get(j) === lightest),
      random,
    );
    give(judgeId, next.project.id, "greedy");
  }

  // Each judge's new projects in a seeded order: the review order the console shows.
  const order: Record<string, string[]> = {};
  for (const j of judges) {
    const mine = pairs.filter((p) => p.judgeId === j.id).map((p) => p.projectId);
    if (mine.length) order[j.id] = shuffle(mine.sort(), random);
  }

  return {
    pairs,
    order,
    underReviewed: projects
      .map((p) => ({ projectId: p.id, eligible: eligible.get(p.id)!.length }))
      .filter((u) => u.eligible < 2),
    short: projects
      .map((p) => ({ projectId: p.id, reviews: filled.get(p.id)!, target }))
      .filter((s) => s.reviews < target),
    loads: Object.fromEntries(judges.map((j) => [j.id, load.get(j.id)!])),
    bridge,
  };
}
