/**
 * What the Judges table says about a judge's unfinished reviews. While judging runs they are open
 * work and the organizer can copy a reminder; once results are published scoring is over, so the
 * table says so and offers no reminder (a judge's own console says the same: scores are final).
 */
export function openWork(pending: number, published: boolean): { group: string; label: string; remind: boolean; note: string | null } {
  return published
    ? { group: "Unfinished", label: `${pending} unfinished`, remind: false, note: "Results are published, so scoring is over." }
    : { group: "Open reviews", label: `${pending} open`, remind: true, note: null };
}
