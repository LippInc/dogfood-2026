/**
 * Which project the judge console opens on. A ?project= in the address wins when it is in the batch.
 * Otherwise the first project that still needs a score (pending and open to change), else the first
 * one not recused, so a returning judge never lands on a project they may not score; 0 when every
 * project is recused (or there are none).
 */
export function startIndex(items: readonly { project: { id: string }; status: string; readOnly: string | null }[], asked: string | null): number {
  const wanted = asked ? items.findIndex((i) => i.project.id === asked) : -1;
  if (wanted >= 0) return wanted;
  const toScore = items.findIndex((i) => i.status === "pending" && !i.readOnly);
  if (toScore >= 0) return toScore;
  const notRecused = items.findIndex((i) => i.status !== "recused");
  return notRecused >= 0 ? notRecused : 0;
}
