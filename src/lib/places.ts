/** Competition-style places for rows sorted best first: tied projects share the first place of their group. */
export function competitionPlaces(rows: { score: number | null }[]): { place: number | null; joint: boolean }[] {
  return rows.map((r, i) => {
    if (r.score === null) return { place: null, joint: false };
    const first = rows.findIndex((x) => x.score !== null && Math.abs(x.score - r.score!) <= 1e-9);
    const joint = rows.filter((x) => x.score !== null && Math.abs(x.score - r.score!) <= 1e-9).length > 1;
    return { place: first + 1, joint: joint || first !== i };
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
