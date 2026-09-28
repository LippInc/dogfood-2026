import { formatUtc } from "@/lib/format";
import { ruleMoves } from "@/lib/vote-rules";

type Change = { at: string; reason: string; before: { modes: string[]; votesPerVoter: number }; after: { modes: string[]; votesPerVoter: number } };

/**
 * The community vote's rules changed after the first ballot came in, each change with the organizers'
 * reason: drawn beside the count wherever it is shown, like the rubric weights changed after scoring.
 */
export function VoteRuleChanges({ changes, className = "" }: { changes: Change[]; className?: string }) {
  if (!changes.length) return null;
  return (
    <div className={`border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-15 text-flag ${className}`}>
      <p className="font-semibold">The organizers changed the vote&rsquo;s rules after ballots were in.</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {changes.map((c, i) => (
          <li key={i}>
            <span className="tnum">{formatUtc(c.at)}</span>: {ruleMoves(c)}. Their reason: &ldquo;{c.reason}&rdquo;
          </li>
        ))}
      </ul>
    </div>
  );
}
