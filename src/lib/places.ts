/** Competition-style places for rows sorted best first: tied projects share the first place of their group. */
export function competitionPlaces(rows: { score: number | null }[]): { place: number | null; joint: boolean }[] {
  return rows.map((r, i) => {
    if (r.score === null) return { place: null, joint: false };
    const first = rows.findIndex((x) => x.score !== null && Math.abs(x.score - r.score!) <= 1e-9);
    const joint = rows.filter((x) => x.score !== null && Math.abs(x.score - r.score!) <= 1e-9).length > 1;
    return { place: first + 1, joint: joint || first !== i };
  });
}

export const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
