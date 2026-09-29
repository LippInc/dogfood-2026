import { plural } from "@/lib/format";
import { closeCall, type Normalized, type ProjectRow } from "@/server/dal";

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const end = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${end}`;
}

/** An average rank as a place: 3 is "3rd"; 2.5, two projects sharing 2nd and 3rd, is "a shared 2nd". */
function place(rank: number): string {
  return Number.isInteger(rank) ? ordinal(rank) : `a shared ${ordinal(Math.floor(rank))}`;
}

/** "A", "A and B", "A, B and C" */
function names(list: string[]): string {
  return list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** `unchecked`: a lone leader the rule cannot check yet, because a ranked project of its track has no ± */
type Leader = { track: string; titles: string[]; close: boolean; unchecked: boolean };

/**
 * A track's first place, and whether it is too close to call: the close-call rule the Results page's
 * "Close calls" and the Overview's decisions use (JUDGING.md, "Close calls"), so the three never disagree.
 */
function leaderOf(track: string, rows: ProjectRow[]): Leader | null {
  const ranked = rows.filter((p) => p.trackRank !== null && p.score !== null && !p.duplicateOf).sort((a, b) => a.trackRank! - b.trackRank!);
  if (!ranked.length) return null;
  const top = ranked.filter((p) => p.trackRank === ranked[0]!.trackRank);
  if (top.length > 1) return { track, titles: top.map((p) => p.title), close: false, unchecked: false };
  const cc = closeCall(ranked.map((p) => ({ id: p.id, score: p.score!, se: p.se })));
  // a track of one ranked project has nothing to call; two or more with no call means a missing ±, which is no verdict
  return { track, titles: [ranked[0]!.title], close: Boolean(cc && !cc.callable), unchecked: !cc && ranked.length > 1 };
}

/**
 * The organizer results page's plain words: what this run shows, one point per kind of fact, above
 * its statistics. Said from the same numbers the page draws; the open decisions are said once, in
 * the page header. Leaving a judge out is Fig. 01's number, so the leniency point counts only what
 * evening out leniency moves: the kept judges' plain ranking against the adjusted one.
 */
export function plainSummary(n: Normalized, opts: { open: number; published: boolean; differs?: number }): string[] {
  const ranked = n.projects.filter((p) => p.score !== null);
  if (!ranked.length) return ["No project has a counted review yet, so nothing is ranked."];
  const unranked = n.projects.filter((p) => p.score === null && !p.duplicateOf).length;
  const tracks = [...new Map(n.projects.map((p) => [p.trackId, p.trackName])).entries()];
  const reviews = ranked.reduce((s, p) => s + p.n, 0);
  const judges = n.judges.filter((j) => !j.excluded && j.n > 0).length;
  const lines: string[] = [];

  lines.push(
    `${plural(ranked.length, "project")} in ${plural(new Set(ranked.map((p) => p.trackId)).size, "track")} ${ranked.length === 1 ? "is" : "are"} ranked, from ${plural(reviews, "counted review")} by ${plural(judges, "judge")}.` +
      (unranked ? ` ${plural(unranked, "project")} ${unranked === 1 ? "has" : "have"} no counted review yet, so ${unranked === 1 ? "it is" : "they are"} not ranked.` : ""),
  );

  const leaders = tracks.map(([id, name]) => leaderOf(name, n.projects.filter((p) => p.trackId === id))).filter((l): l is Leader => l !== null);
  lines.push(`First in each track: ${leaders.map((l) => (l.titles.length > 1 ? `${names(l.titles)}, tied (${l.track})` : `${l.titles[0]} (${l.track})`)).join("; ")}.`);
  const close = leaders.filter((l) => l.close).map((l) => l.track);
  const leads = leaders.filter((l) => l.titles.length === 1).length;
  // a tied track has no lead to measure, so a count says which tracks it is out of
  const tracksLed = leads < leaders.length ? "tracks with one leader" : "tracks";
  const unchecked = leaders.filter((l) => l.unchecked).map((l) => l.track);
  if (!close.length && unchecked.length) {
    // without a ± the rule has not looked, so nothing is said to be clear
    if (unchecked.length === leads) lines.push("Not enough reviews yet to say whether any first place is clear from the scores: a leader is checked once every project of its track has a ±.");
    else lines.push(`Not enough reviews yet to say whether first place is clear in ${names(unchecked)}; every other first place is clear from the scores.`);
  } else if (!close.length) lines.push("Every first place is clear from the scores: each leader comes out first in at least 95 % of the draws around the scores' ±.");
  else if (close.length === 1) lines.push(`In ${close[0]}, first place is too close to call from the scores: see Close calls below.`);
  else if (close.length === leads)
    lines.push(`In every ${tracksLed === "tracks" ? "track" : "track with one leader,"} first place is too close to call from the scores: see Close calls below.`);
  else lines.push(`In ${close.length} of the ${leads} ${tracksLed} first place is too close to call from the scores: ${names(close)}; see Close calls below.`);

  if (!n.variance.measured) lines.push("No project has two counted reviews yet, so nothing is evened out: places come from the plain averages.");
  else if (!n.variance.leniencyMeasured) lines.push("Too few reviews to estimate how lenient each judge is, so scores are used as given: places come from the plain averages.");
  else if (n.variance.k === null) lines.push("The judges show no steady leniency, so places come from the plain averages.");
  else {
    const moves = ranked
      .filter((p) => p.rankKept !== null && p.rankNormalized !== null && Math.abs(p.rankNormalized - p.rankKept) >= 1)
      .map((p) => ({ title: p.title, from: p.rankKept!, to: p.rankNormalized! }));
    const most = moves.reduce<(typeof moves)[number] | null>((m, r) => (!m || Math.abs(r.to - r.from) > Math.abs(m.to - m.from) ? r : m), null);
    lines.push(
      most
        ? `Evening out each judge's leniency moves ${moves.length} of the ${ranked.length} projects by a place or more in the overall order; the most, ${most.title}, from ${place(most.from)} to ${place(most.to)}.`
        : "Evening out each judge's leniency changes no project's place.",
    );
  }

  const byHand = n.judges.filter((j) => j.excluded && j.override?.mode === "exclude").map((j) => j.name);
  const flat = n.judges.filter((j) => j.excluded && j.override?.mode !== "exclude").map((j) => j.name);
  if (flat.length)
    lines.push(`${names(flat)} ${flat.length === 1 ? "is" : "are"} left out for giving every project the same scores; you can count them again, with a reason, on the overview.`);
  if (byHand.length) lines.push(`${names(byHand)} ${byHand.length === 1 ? "is" : "are"} left out by an organizer's decision; the reason is under the method below.`);
  const thin = ranked.filter((p) => p.underReviewed).length;
  if (thin)
    lines.push(
      thin === 1
        ? "1 ranked project has fewer than two counted reviews and is marked under-reviewed."
        : `${thin} ranked projects have fewer than two counted reviews and are marked under-reviewed.`,
    );

  if (opts.published && opts.differs) lines.push("These places are worked out again now and differ from the published ones (see above); below is how.");
  else if (opts.published) lines.push("These places are published; below is how they were worked out.");
  else if (opts.open === 0) lines.push("Nothing waits on you: you can publish from the overview.");
  return lines;
}
