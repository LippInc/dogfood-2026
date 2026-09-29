import type { ReactNode } from "react";
import { plural } from "@/lib/format";
import { CORRECTED_FROM } from "@/lib/ranking-evidence";
import { JUDGING_URL } from "@/lib/source";
import type { PublishedResults } from "@/server/dal";

// The public results page's "How this ranking was reached": the method, how strongly it corrected the
// judges, the signal check's verdict and the audit entry the run is pinned to, in plain words. Every
// number comes from the published run (getPublishedResults' evidence and anchor), all of them totals
// over the judges: this block never names a judge or shows one judge's figure. Display only; the engine
// is not run here. Server-rendered, no motion, nothing that loads later.

type Published = Extract<PublishedResults, { published: true }>;

const f2 = (v: number) => v.toFixed(2);
const pct = (v: number) => `${Math.round(v * 100)} %`;
/** A signal share above this reads as "no better than chance" (the organizer's Results page uses the same line). */
const SIGNAL_LINE = 0.05;

const link = "underline underline-offset-4 hover:text-accent-ink";

type PairwiseEvidence = Extract<Published["evidence"], { kind: "pairwise" }>;

/**
 * Where a pairwise ranking's comparisons came from, each kind counted apart: judges' answers and
 * the pairs implied by scores given before the switch. The results page's reading point, its "How
 * these win % were made" and this block's Method all use it, so none of them can let a reader take
 * the pairs implied by scores for judges' answers.
 */
export function pairwiseSources(e: PairwiseEvidence): string {
  const answers = `${plural(e.answers, "answer")} from judges to “which of these two is better?” about projects they were given to judge`;
  return e.fromScores ? `${answers} and ${plural(e.fromScores, "pair")} implied by scores given before the switch to this way of judging` : answers;
}

/** Said when the pairs implied by scores outnumber the answers, so the ranking rests mostly on the scores. */
export function mostlyFromScores(e: PairwiseEvidence): string | null {
  return e.fromScores > e.answers ? "More of these comparisons come from the scores than from answers." : null;
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-1 border-t border-rule py-3 md:grid-cols-[160px_minmax(0,1fr)]">
      <dt className="label-mono pt-0.5 text-ink-3">{term}</dt>
      <dd className="text-15 leading-6 text-ink">{children}</dd>
    </div>
  );
}

export function RankingEvidence({ results }: { results: PublishedResults }) {
  if (!results.published) return null;
  const { evidence: e, anchor } = results as Published;
  const plainFigure = e.kind === "pairwise" ? "their plain share of wins" : "the plain average of every review";
  const leftOut = e.excluded
    ? ` ${plural(e.excluded, "judge")} ${e.excluded === 1 ? "was" : "were"} left out as a whole, by the portal’s rules or an organizer’s written decision.`
    : "";

  let method: string;
  let correction: string | null;
  if (e.kind === "pairwise") {
    const mostly = mostlyFromScores(e);
    method = `Each project’s win % is fitted from ${pairwiseSources(e)}, from ${plural(e.judges, "judge")}${e.fromScores ? " in all" : ""}.${mostly ? ` ${mostly}` : ""}`;
    const SIDE = "the side a project was shown on";
    const FRESH = "the project a judge had just opened";
    const measured = (p: typeof e.left, what: string) => (p ? `${what} (${pct(p.share)} ± ${p.pm} between two equal projects)` : null);
    const side = measured(e.left, SIDE);
    const fresh = measured(e.fresh, FRESH);
    correction =
      (side && fresh
        ? `The fit measured two pulls and corrected every strength for them: ${side} and ${fresh}.`
        : side || fresh
          ? `The fit measured one pull and corrected for it, ${side ?? fresh}; the other, ${side ? FRESH : SIDE}, had too few answers to measure, and the fit assumes almost none.`
          : `The fit watches for two pulls, ${SIDE} and ${FRESH}; there were too few answers to measure either, and the fit assumes almost none.`) + leftOut;
  } else if (e.k === null) {
    method = "Rubric scores as plain averages: the judges showed no steady leniency, so nothing was taken off anyone’s reviews.";
    correction = leftOut ? leftOut.trim() : null;
  } else {
    method = `Rubric scores with each judge’s leniency taken out, measured from this event’s own scores (k = ${e.k.toFixed(1)}).`;
    const j = e.judges;
    correction = j
      ? (j.corrected
          ? `${j.corrected} of the ${plural(j.counted, "counted judge")} ${j.corrected === 1 ? "was" : "were"} corrected by at least ${CORRECTED_FROM} points of a review’s total; the largest correction was ${f2(j.largest)}, the median ${f2(j.median)}.`
          : `No counted judge’s correction reaches ${CORRECTED_FROM} points of a review’s total (${plural(j.counted, "counted judge")}).`) + leftOut
      : leftOut
        ? leftOut.trim()
        : null;
  }

  const effect = e.moved
    ? `${e.moved} of the ${plural(e.placed, "project")} stand at a different place in their track than ${plainFigure} would put them.`
    : `Every project stands at the place in its track that ${plainFigure} would give it.`;

  let signal: string | null = null;
  if (e.kind === "scores" && e.signal) {
    const hits = Math.round(e.signal.share * e.signal.trials);
    const of = `${hits.toLocaleString("en")} of ${e.signal.trials.toLocaleString("en")}`;
    signal =
      e.signal.share > SIGNAL_LINE
        ? `Shuffling the review totals spread the projects as far apart as the real scores in ${of} shuffles, so these scores do not separate the projects better than chance: read close places as ties.`
        : `Only ${of} shuffles of the review totals spread the projects as far apart as the real scores: the scores separate the projects better than chance.`;
  }

  return (
    <section id="how-reached" aria-labelledby="how-reached-title" className="mt-16 max-w-[860px] scroll-mt-6 border-t border-rule pt-6">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <h2 id="how-reached-title" className="label-mono text-ink">
          Fig. 03 — How this ranking was reached
        </h2>
        <p className="text-13 text-ink-3">From the stored run these places come from; totals only, no judge is named.</p>
      </div>
      <dl className="mt-4 border-b border-rule">
        <Row term="Method">{method}</Row>
        {correction ? <Row term="Correction">{correction}</Row> : null}
        <Row term="Effect">{effect}</Row>
        {signal ? <Row term="Signal check">{signal}</Row> : null}
        {anchor ? (
          <Row term="Audit log">
            Published as entry #{anchor.entry}, hash <span className="font-mono text-13 break-all">{anchor.hash.slice(0, 16)}…</span> (the seal near the top shows it in full). Each
            entry carries the hash of the one before, so a later change to the log up to it would change this hash.{" "}
            <a href={`${JUDGING_URL}#the-audit-trail`} className={link}>
              How the audit chain works
            </a>{" "}
            ·{" "}
            <a href="/verify" className={link}>
              Check a signed record
            </a>
          </Row>
        ) : null}
        <Row term="In full">
          The model, how it was tested and what it does not do:{" "}
          <a href={JUDGING_URL} className={link}>
            JUDGING.md
          </a>{" "}
          in the portal&rsquo;s source.
        </Row>
      </dl>
    </section>
  );
}
