import type { Influence, JudgeStanding, Normalized } from "@/server/dal";
import { overrideAction, undoOverrideAction } from "../decision-actions";
import { OneClick, WithReason } from "../decisions";

// The judge ledger: one row per judge with what the engine does to their reviews
// (leniency ± one standard error, the share of their tilt it keeps), the flags and
// overrides on them, the single-judge influence check, and the override itself.

const f2 = (v: number) => v.toFixed(2);
/** Signed to two decimals; a value that rounds to zero shows as 0.00, never −0.00. */
const signed = (v: number) => (Math.abs(v) < 0.005 ? "0.00" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`);
const rk = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function Standing({ j }: { j: JudgeStanding }) {
  if (j.override) {
    return (
      <p className={`text-12 ${j.excluded ? "text-flag" : "text-ink-2"}`}>
        {j.override.mode === "include" ? "Reinstated" : "Left out"} by an organizer: “{j.override.reason}”
      </p>
    );
  }
  if (j.flag) {
    return (
      <p className="text-12 text-flag">
        Flat: {j.flag.vector.join(" / ")} on all {j.flag.reviews} projects, so the rule leaves this judge out
      </p>
    );
  }
  return null;
}

function IfFlipped({ inf }: { inf: Influence }) {
  const lead = inf.change === "leave_out" ? "Left out" : "Counted again";
  return (
    <div className="flex flex-col gap-0.5">
      <p>
        {lead}: {inf.moved} {inf.moved === 1 ? "project moves" : "projects move"}
        {inf.unranked ? `, ${inf.unranked} left unranked` : ""}
      </p>
      {inf.biggest ? (
        <p className="text-12 text-ink-2">
          most: {inf.biggest.title}, {rk(inf.biggest.from)} → {rk(inf.biggest.to)}
        </p>
      ) : null}
      {inf.leaders.length ? (
        inf.leaders.map((l) => (
          <p key={l.trackId} className="text-12 text-flag">
            {l.trackName} first place: {l.from.join(" = ") || "none"} → {l.to.join(" = ") || "none"}
          </p>
        ))
      ) : (
        <p className="text-12 text-ink-2">every track keeps its first place</p>
      )}
    </div>
  );
}

function Action({ j, eventSlug }: { j: JudgeStanding; eventSlug: string }) {
  if (j.override) {
    return <OneClick label="Undo" variant="outline" action={undoOverrideAction} fields={{ judge: j.id }} eventSlug={eventSlug} />;
  }
  if (j.excluded) {
    return (
      <WithReason label="Reinstate…" submit="Reinstate" action={overrideAction} hidden={{ judge: j.id, mode: "include" }} eventSlug={eventSlug} idKey={`in-${j.id}`} />
    );
  }
  return (
    <WithReason label="Leave out…" submit="Leave out" action={overrideAction} hidden={{ judge: j.id, mode: "exclude" }} eventSlug={eventSlug} idKey={`out-${j.id}`} />
  );
}

/** The influence check in one sentence: how much one counted judge moves, and how often a first place changes. */
function Summary({ judges }: { judges: JudgeStanding[] }) {
  const out = judges.filter((j) => j.influence?.change === "leave_out").map((j) => j.influence!);
  if (out.length < 2) return null;
  const moves = out.map((i) => i.moved).sort((a, b) => a - b);
  const median = moves.length % 2 ? moves[(moves.length - 1) / 2]! : (moves[moves.length / 2 - 1]! + moves[moves.length / 2]!) / 2;
  const firsts = out.filter((i) => i.leaders.length).length;
  return (
    <p className="max-w-[860px] text-14">
      <strong>
        Leaving out one counted judge at a time moves between {moves[0]} and {moves[moves.length - 1]} projects (median {median}); for {firsts} of {out.length}{" "}
        judges a track&rsquo;s first place changes.
      </strong>{" "}
      The more a single review can move, the less the ranking should be read to the place.
    </p>
  );
}

export function JudgeLedger({ n, eventSlug, published }: { n: Normalized; eventSlug: string; published: boolean }) {
  const k = n.variance.k;
  const judges = n.judges.filter((j) => j.nAll > 0 || j.override);
  const idle = n.judges.length - judges.length;
  return (
    <section aria-labelledby="ledger-title" className="flex flex-col gap-3">
      <h2 id="ledger-title" className="text-17 font-semibold">
        Judge ledger
      </h2>
      <p className="max-w-[860px] text-14 text-ink-2">
        A judge&rsquo;s leniency is what the engine takes off each of their reviews: their plain tilt against the other reviewers of the same projects, of which it
        keeps n ÷ (n + k). The ± is one standard error; a leniency within about two of them of zero cannot be told apart from zero. The last columns rerun the whole
        engine with that one judge&rsquo;s status flipped, so you see what an override would change before you make it.
        {published ? " The results are published, so the judge set is final." : ""}
      </p>
      <Summary judges={judges} />
      <div className="overflow-x-auto rounded-sm border border-rule bg-surface">
        <table className="w-full text-14">
          <thead>
            <tr className="border-b border-rule text-left text-13 text-ink-2">
              <th className="px-3 py-2 font-medium">Judge</th>
              <th className="px-3 py-2 text-right font-medium">Reviews counted</th>
              <th className="px-3 py-2 text-right font-medium">Plain tilt</th>
              <th className="px-3 py-2 text-right font-medium">Leniency ± error</th>
              <th className="px-3 py-2 text-right font-medium">Tilt kept</th>
              <th className="px-3 py-2 font-medium">If flipped</th>
              {published ? null : <th className="px-3 py-2 font-medium">Override</th>}
            </tr>
          </thead>
          <tbody>
            {judges.map((j) => (
              <tr key={j.id} className="border-b border-rule align-top last:border-b-0">
                <td className="px-3 py-2">
                  <p className="font-medium">{j.name}</p>
                  <Standing j={j} />
                </td>
                <td className="px-3 py-2 text-right tnum">{j.excluded ? `0 of ${j.nAll}` : j.n}</td>
                <td className="px-3 py-2 text-right tnum">{j.tilt === null || j.excluded ? "–" : signed(j.tilt)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap tnum">
                  {j.excluded ? "left out" : k === null ? "not corrected" : j.se === null ? "–" : `${signed(j.leniency)} ± ${f2(j.se)}`}
                </td>
                <td className="px-3 py-2 text-right tnum">{j.excluded || k === null ? "–" : `${Math.round(j.shrink * 100)} %`}</td>
                <td className="min-w-[220px] px-3 py-2 text-13">{j.influence ? <IfFlipped inf={j.influence} /> : "–"}</td>
                {published ? null : (
                  <td className="min-w-[180px] px-3 py-2">
                    <div className="flex items-start">
                      <Action j={j} eventSlug={eventSlug} />
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {idle ? (
        <p className="text-13 text-ink-2">
          {idle} {idle === 1 ? "judge has" : "judges have"} no finished review yet and {idle === 1 ? "is" : "are"} not listed.
        </p>
      ) : null}
    </section>
  );
}
