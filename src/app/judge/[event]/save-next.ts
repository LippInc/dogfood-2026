/** One project in a judge's batch, as Save and open next sees it. */
export type Slot = {
  /** the judge can still score it: not recused, not read-only */
  open: boolean;
  /** every criterion has a score */
  scored: boolean;
};

/**
 * Where Save and open next goes from `index`: the next unfinished project, looking past the end;
 * once every project is scored, the next one in order with the batch-done line, and on the last one
 * it stays with that line rather than wrapping silently to the first. Read-only browsing wraps as before.
 */
export function saveAndNextTarget(slots: readonly Slot[], index: number): { to: number; batchDone: boolean } {
  const n = slots.length;
  for (let step = 1; step < n; step++) {
    const j = (index + step) % n;
    if (slots[j]!.open && !slots[j]!.scored) return { to: j, batchDone: false };
  }
  const here = slots[index]!;
  if (here.open && here.scored) return { to: index + 1 < n ? index + 1 : index, batchDone: true };
  return { to: (index + 1) % n, batchDone: false };
}

/**
 * The batch is finished when at least one project counts and every project that counts has every score. A recused
 * project counts as done (it leaves the batch); a batch recused throughout has nothing to finish. Clearing any score
 * of a counted project makes it unfinished again.
 */
export function batchFinished(slots: readonly { recused: boolean; scored: boolean }[]): boolean {
  const counted = slots.filter((s) => !s.recused);
  return counted.length > 0 && counted.every((s) => s.scored);
}
