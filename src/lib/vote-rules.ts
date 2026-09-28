type Rules = { modes: string[]; votesPerVoter: number };

const WAYS: Record<string, string> = { account: "signed-in accounts", listed: "the voter list", link: "the open link" };
const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * What a change to the community vote's rules did, in words: "favourites per voter 3 → 5; opened to
 * signed-in accounts; closed to the open link". Closing a way in stops its new ballots; the ones it
 * already brought stay in the count.
 */
export function ruleMoves(change: { before: Rules; after: Rules }): string {
  const { before, after } = change;
  const parts: string[] = [];
  if (before.votesPerVoter !== after.votesPerVoter) parts.push(`favourites per voter ${before.votesPerVoter} → ${after.votesPerVoter}`);
  const opened = after.modes.filter((m) => !before.modes.includes(m));
  const closed = before.modes.filter((m) => !after.modes.includes(m));
  if (opened.length) parts.push(`opened to ${andList(opened.map((m) => WAYS[m] ?? m))}`);
  if (closed.length) parts.push(`closed to ${andList(closed.map((m) => WAYS[m] ?? m))}`);
  return parts.join("; ");
}
