// People's names in the order a reader expects: letters with accents next to their base letter
// (Árpád among the A's, not after Zsolt, as SQLite's byte order puts them), case not splitting
// the list, and "Judge 9" before "Judge 10". One fixed locale, so the order is the same on every
// portal whatever the machine's language.
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "variant" });

export const compareNames = (a: string, b: string): number => collator.compare(a, b);

/** A copy of the rows sorted by a name field; rows with equal names keep their order (the sort is stable). */
export function sortByName<T>(rows: T[], name: (row: T) => string): T[] {
  return [...rows].sort((x, y) => compareNames(name(x), name(y)));
}
