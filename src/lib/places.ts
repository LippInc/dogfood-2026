/**
 * Competition-style places for rows sorted best first: tied projects share the first place of their group. A row may
 * carry `tie`, its figure on the event's tie-break criterion (src/server/judging/tiebreak.ts), set only on rows whose
 * score is exactly tied with another's: among those, a higher figure places first, and only rows tied on both share
 * a place. With no row carrying a figure, the places are exactly the scores' own.
 */
export function competitionPlaces(rows: { score: number | null; tie?: number | null }[]): { place: number | null; joint: boolean }[] {
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
