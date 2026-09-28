type Weights = { id: string; label: string; weight: number }[];

/** The weights a change moved, in words: "Functionality 1 → 2, Innovation 1 → 0.5". */
export function weightMoves(change: { before: Weights; after: Weights }): string {
  return change.after
    .flatMap((a) => {
      const b = change.before.find((x) => x.id === a.id);
      return b && b.weight !== a.weight ? [`${a.label} ${b.weight} → ${a.weight}`] : [];
    })
    .join(", ");
}
