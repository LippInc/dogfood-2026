/**
/**
 * Competition-style places for rows sorted best first: tied projects share the first place of their group. A row may
 * carry `tie`, its figure on the event's tie-break criterion (src/server/judging/tiebreak.ts), set only on rows whose
 * score is exactly tied with another's: among those, a higher figure places first, and only rows tied on both share
 * a place. With no row carrying a figure, the places are exactly the scores' own. A first row marked `decided` (the
 * judges' decision on a close call named it the winner) is 1st alone, whatever its score, and the rest are placed by
 * the same rule from 2nd on.
 */
export function competitionPlaces(rows: { score: number | null; tie?: number | null; decided?: boolean }[]): { place: number | null; joint: boolean }[] {
  if (rows[0]?.decided) {
    return [{ place: 1, joint: false }, ...competitionPlaces(rows.slice(1)).map((p) => (p.place === null ? p : { ...p, place: p.place + 1 }))];
  }
  if (rows.some((r) => typeof r.tie === "number")) return tieBrokenPlaces(rows);
  return rows.map((r, i) => {
    if (r.score === null) return { place: null, joint: false };
    const first = rows.findIndex((x) => x.score !== null && Math.abs(x.score - r.score!) <= 1e-9);
    const joint = rows.filter((x) => x.score !== null && Math.abs(x.score - r.score!) <= 1e-9).length > 1;
    return { place: first + 1, joint: joint || first !== i };
  });
}

function tieBrokenPlaces(rows: { score: number | null; tie?: number | null }[]): { place: number | null; joint: boolean }[] {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
  const figure = (r: { tie?: number | null }) => (typeof r.tie === "number" ? r.tie : null);
  return rows.map((r) => {
    if (r.score === null) return { place: null, joint: false };
    const mine = figure(r);
    let ahead = 0;
    let alike = 0;
    for (const x of rows) {
      if (x.score === null) continue;
      if (x.score > r.score + 1e-9) ahead++;
      else if (near(x.score, r.score)) {
        const theirs = figure(x);
        if (mine !== null && theirs !== null && theirs > mine + 1e-9) ahead++;
        else if (mine === null || theirs === null || near(theirs, mine)) alike++;
      }
    }
    return { place: ahead + 1, joint: alike > 1 };
  });
}

/**
 * Whether the event's tie-break decided this row's place (JUDGING.md, "Breaking exact ties"): the criterion split the
 * row's exact score tie and left the row alone at its place. A row the criterion left joint with another (two tied on
 * it too, both ahead of or behind a third) says nothing: its place is still a joint one. The one condition every page,
 * the embed, the certificates and normalized.csv use before saying "tie broken by".
 */
export function tieDecided(row: { tieBroken?: boolean }, place: { place: number | null; joint: boolean }): boolean {
  return row.tieBroken === true && place.place !== null && !place.joint;
}

/**
 * The note beside a place the tie-break decided, the same words on every page. "Exactly": the public results call any
 * gap under about two ± a tie, and this rule orders only scores that are the same number.
 */
export const tieBrokenWords = (criterion: string) => `Exactly tied on score; tie broken by ${criterion}`;

/** The public method block's sentence on the tie-break, shown only when the published run used one. */
export const tieBreakMethod = (criterion: string) =>
  `Projects with exactly the same score are then ordered by their plain average on ${criterion}, a rule the organizers chose; it is a convention, not a measured difference.`;

/** Each id's competition place by its value, highest first, with the same tie rule as competitionPlaces: values within 1e-9 share a place. */
export function competitionPlaceOf(values: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, v] of values) {
    let better = 0;
    for (const w of values.values()) if (w > v + 1e-9) better++;
    out.set(id, better + 1);
  }
  return out;
}

export const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

/**
 * A podium award as a certificate words it ("Joint 1st place, Health", or "2nd place, Health, tie broken by Impact"
 * when the event's tie-break decided it), read back into its parts; null for any other award (a community vote win).
 */
export function awardPlace(award: string): { place: number; ordinal: string; joint: boolean; track: string; tieBrokenBy: string | null } | null {
  const m = /^(Joint )?(([0-9]+)(?:st|nd|rd|th)) place, (.+?)(?:, tie broken by (.+))?$/.exec(award);
  return m ? { joint: Boolean(m[1]), ordinal: m[2]!, place: Number(m[3]), track: m[4]!, tieBrokenBy: m[5] ?? null } : null;
}

/** A prize award as a certificate words it ("Winner, Best in show", "Joint winner, Best in show"), read back into its parts; null for any other award. */
export function prizeOf(award: string): { joint: boolean; prize: string } | null {
  const m = /^(Joint winner|Winner), (.+)$/.exec(award);
  return m ? { joint: m[1] === "Joint winner", prize: m[2]! } : null;
}
