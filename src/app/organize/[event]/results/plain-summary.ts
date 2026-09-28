import { plural } from "@/lib/format";
import type { Normalized, ProjectRow } from "@/server/dal";

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const end = teen ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${end}`;
}

/** An average rank as a place: 3 is "3rd"; 2.5, two projects sharing 2nd and 3rd, is "a shared 2nd". */
function place(rank: number): string {
  return Number.isInteger(rank) ? ordinal(rank) : `a shared ${ordinal(Math.floor(rank))}`;
}

const f2 = (x: number) => x.toFixed(2);

/** "A", "A and B", "A, B and C" */
function names(list: string[]): string {
  return list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** One track's first place: the leader, a tie, or a lead inside the margin of error (read as a tie, as the published page says). */
function firstPlace(trackName: string, rows: ProjectRow[]): string | null {
  const ranked = rows.filter((p) => p.trackRank !== null && p.score !== null).sort((a, b) => a.trackRank! - b.trackRank!);
  if (!ranked.length) return null;
  const top = ranked.filter((p) => p.trackRank === ranked[0]!.trackRank);
  const lead = ranked[0]!;
  if (top.length > 1) return `First in ${trackName}: a tie between ${names(top.map((p) => p.title))}, ${f2(lead.score!)}.`;
  const margin = lead.se !== null ? ` ± ${f2(lead.se)}` : "";
  const next = ranked[1];
  const gap = next ? lead.score! - next.score! : null;
  const inside = next && gap !== null && Math.max(lead.se ?? 0, next.se ?? 0) > gap;
  return inside
    ? `First in ${trackName}: ${lead.title}, ${f2(lead.score!)}${margin}, only ${f2(gap)} ahead of ${next.title}: a gap inside the margin of error, so read it as a tie.`
    : `First in ${trackName}: ${lead.title}, ${f2(lead.score!)}${margin}.`;
}

/**
 * The organizer results page's plain words: what this run shows, one point each, above its statistics.
 * Said from the same numbers the page draws; the open decisions are said once, in the page header.
 */
export function plainSummary(n: Normalized, opts: { open: number; published: boolean }): string[] {
  const ranked = n.projects.filter((p) => p.score !== null);
  if (!ranked.length) return ["No project has a counted review yet, so nothing is ranked."];
  const unranked = n.projects.filter((p) => p.score === null && !p.duplicateOf).length;
  const tracks = [...new Map(n.projects.map((p) => [p.trackId, p.trackName])).entries()];
  const rankedTracks = new Set(ranked.map((p) => p.trackId)).size;
  const reviews = ranked.reduce((s, p) => s + p.n, 0);
  const judges = n.judges.filter((j) => !j.excluded && j.n > 0).length;
  const lines: string[] = [];

  lines.push(
    `${plural(ranked.length, "project")} in ${plural(rankedTracks, "track")} ${ranked.length === 1 ? "is" : "are"} ranked, from ${plural(reviews, "counted review")} by ${plural(judges, "judge")}.` +
      (unranked ? ` ${plural(unranked, "project")} ${unranked === 1 ? "has" : "have"} no counted review yet, so ${unranked === 1 ? "it is" : "they are"} not ranked.` : ""),
  );
  for (const [id, name] of tracks) {
    const line = firstPlace(name, n.projects.filter((p) => p.trackId === id));
    if (line) lines.push(line);
  }
  if (!n.variance.measured) lines.push("No project has two counted reviews yet, so nothing is evened out: places come from the plain averages.");
  else if (n.variance.k === null) lines.push("The judges show no steady leniency, so places come from the plain averages.");
  else if (n.moved === 0 || !n.biggestMove) lines.push("Evening out each judge's leniency changes no project's place.");
  else
    lines.push(
      `Evening out each judge's leniency moves ${n.moved} of the ${ranked.length} projects by a place or more in the overall order; the most, ${n.biggestMove.title}, from ${place(n.biggestMove.from)} to ${place(n.biggestMove.to)}.`,
    );

  const byHand = n.judges.filter((j) => j.excluded && j.override?.mode === "exclude").map((j) => j.name);
  const flat = n.judges.filter((j) => j.excluded && j.override?.mode !== "exclude").map((j) => j.name);
  if (flat.length)
    lines.push(
      `${names(flat)} ${flat.length === 1 ? "is" : "are"} left out for giving every project the same scores; you can count them again, with a reason, on the overview.`,
    );
  if (byHand.length)
    lines.push(`${names(byHand)} ${byHand.length === 1 ? "is" : "are"} left out by an organizer's decision; the reason is under the method below.`);
  const thin = ranked.filter((p) => p.underReviewed).length;
  if (thin)
    lines.push(
      thin === 1
        ? "1 ranked project has fewer than two counted reviews and is marked under-reviewed."
        : `${thin} ranked projects have fewer than two counted reviews and are marked under-reviewed.`,
    );

  if (opts.published) lines.push("These places are published; below is how they were worked out.");
  else if (opts.open === 0) lines.push("Nothing waits on you: you can publish from the overview.");
  return lines;
}
