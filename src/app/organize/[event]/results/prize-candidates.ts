import "server-only";
import { competitionPlaces } from "@/lib/places";
import { breakTies } from "@/server/judging/tiebreak";
import type { PrizeCandidate } from "./prizes-step";

type CandidateRow = { projectId: string; title: string; teamName: string; score: number | null };

/**
 * Every project that can win a prize, with its place in its track as the results will publish it. The places come from
 * competitionPlaces, the function the public results, the project pages and the certificates place by, over the rows
 * as publishing orders them: best score first, and with a tie-break set, each exact score tie ordered by the
 * criterion's figures (breakTies), so a broken tie reads "1st" and "2nd" here as it will there, never "joint 1st".
 * `tieFigures` holds the criterion figure of each project in an exact score tie (the tie-break view's groups); absent
 * when no tie-break is set.
 */
export function candidatesOf(tracks: { trackName: string; rows: CandidateRow[] }[], tieFigures?: ReadonlyMap<string, number>): PrizeCandidate[] {
  return tracks.flatMap((t) => {
    const ordered = [...t.rows].sort((a, b) => (a.score === null ? 1 : 0) - (b.score === null ? 1 : 0) || (b.score ?? 0) - (a.score ?? 0) || a.projectId.localeCompare(b.projectId));
    const rows = tieFigures ? breakTies(ordered, tieFigures) : ordered;
    const places = competitionPlaces(rows);
    return rows
      .map((r, i) => ({ projectId: r.projectId, title: r.title, teamName: r.teamName, trackName: t.trackName, place: places[i]!.place, joint: places[i]!.place !== null && places[i]!.joint }))
      .sort((a, b) => (a.place ?? Infinity) - (b.place ?? Infinity));
  });
}

/** The criterion figures of the projects in an exact score tie, from the tie-break view getNormalization returns. */
export function tieFiguresOf(tieBreak: { groups: { projects: { id: string; figure: number | null }[] }[] } | undefined): Map<string, number> | undefined {
  if (!tieBreak) return undefined;
  return new Map(tieBreak.groups.flatMap((g) => g.projects.flatMap((p) => (p.figure === null ? [] : [[p.id, p.figure] as const]))));
}

/** The scores-mode candidates, from what getNormalization answers: the canonical projects (a merged copy counts as the one kept) of each track. */
export function scoreCandidates(n: { projects: { id: string; title: string; teamName: string; trackId: string; trackName: string | null; duplicateOf: string | null; score: number | null }[] }, tieBreak?: Parameters<typeof tieFiguresOf>[0]): PrizeCandidate[] {
  const tracks = [...new Map(n.projects.map((p) => [p.trackId, p.trackName])).entries()];
  return candidatesOf(
    tracks.map(([id, name]) => ({
      trackName: name ?? "No track",
      rows: n.projects.filter((p) => p.trackId === id && !p.duplicateOf).map((p) => ({ projectId: p.id, title: p.title, teamName: p.teamName, score: p.score })),
    })),
    tieFiguresOf(tieBreak),
  );
}
