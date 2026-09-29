import Link from "next/link";
import { formatUtc, plural } from "@/lib/format";
import { METHOD_LABEL, type getNormalization, type Normalized } from "@/server/dal";
import { MethodFold } from "./method-fold";

type PublishedCheck = ReturnType<typeof getNormalization>["published"];

/** The one sentence under the heading: what the page is, in an organizer's words, before any statistic. */
export function scoreLead(state: { published: boolean; differs: number }): string {
  if (!state.published) return "Each track's ranking as it will be published, with every judge's leniency evened out so a strict or generous judge does not decide a place.";
  if (state.differs) return "Each track's ranking worked out again from today's data, with every judge's leniency evened out; the published ranking stands until you publish again.";
  return "Each track's ranking as published, with every judge's leniency evened out so a strict or generous judge does not decide a place.";
}

/**
 * The top of the organizer's Results tab in scoring mode: the plain sentence, the numbered lines of
 * what this run shows, the method folded (METHOD_LABEL, k, β̂², σ̂²), and then, outside the fold,
 * the flat-judge rule, who is left out and every override: those are decisions the organizer acts on.
 */
export function ScoreOpening({
  n,
  summary,
  published,
  resultsPublished,
  eventSlug,
  open,
}: {
  n: Normalized;
  summary: string[];
  published: PublishedCheck;
  resultsPublished: boolean;
  eventSlug: string;
  open: number;
}) {
  const excludedNames = n.judges.filter((j) => j.excluded).map((j) => j.name);
  const differs = published?.differs.length ?? 0;
  return (
    <header className="flex flex-col gap-3">
      <p className="label-mono text-ink-2">
        {!resultsPublished ? "Preview: nothing is public until you publish" : differs ? "Worked out again: not the published ranking" : "Published run"}
      </p>
      <h1 className="text-24 font-semibold">The ranking and how it is worked out</h1>
      <p className="max-w-[860px] text-17 leading-7" data-lead="">
        {scoreLead({ published: resultsPublished, differs })}
      </p>
      {published && differs ? (
        <div role="note" className="max-w-[860px] border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-15 text-flag">
          <p className="font-semibold">
            This view is worked out again now and differs from the ranking published {formatUtc(published.computedAt)} for {differs}{" "}
            {differs === 1 ? "project" : "projects"}.
          </p>
          <p className="mt-1">
            The published ranking stands: the public results and normalized.csv read the stored run. A difference here means the engine or the stored
            data changed since publishing.
          </p>
        </div>
      ) : null}
      <ol aria-label="What this run shows, in plain words" className="max-w-[860px] border-b border-rule text-15 wrap-anywhere">
        {summary.map((line, i) => (
          <li key={i} className="grid grid-cols-[36px_minmax(0,1fr)] items-baseline border-t border-rule py-2">
            <span className="font-mono text-12 tnum text-ink-3">{String(i + 1).padStart(2, "0")}</span>
            <span>{line}</span>
          </li>
        ))}
      </ol>
      <MethodFold title="How the leniency correction works" hint="The method in full, with the figures this run measured">
        <p>
          <strong>{METHOD_LABEL}.</strong>{" "}
          {!n.variance.measured
            ? "No project has two counted reviews yet, so this run cannot measure leniency or review noise: it ranks by the plain mean of each project's reviews, with no ±."
            : !n.variance.leniencyMeasured
              ? "No judge has two reviews of projects someone else reviewed too, so this run cannot estimate how lenient each judge is: scores are used as given, and each project ranks by the plain mean of its counted reviews."
              : n.variance.k === null
                ? "This run found no steady leniency (β̂² = 0), so it ranks by the plain mean of each project's counted reviews."
                : `This run: k = ${n.variance.k.toFixed(1)} (β̂² = ${n.variance.beta2.toFixed(3)}, σ̂² = ${n.variance.sigma2.toFixed(3)}), so a judge needs ${plural(Math.round(n.variance.k), "review")} before half their tilt counts.`}
        </p>
      </MethodFold>
      <p className="max-w-[860px] text-15 leading-6 wrap-anywhere" data-flat-rule="">
        Flat-judge rule: a judge with 3 or more reviews and the same scores on every project is left out, as a flag the organizer can overturn with a reason.
        {excludedNames.length ? ` Left out in this run: ${excludedNames.join(", ")}.` : " Nobody is left out in this run."}
      </p>
      {n.judges.some((j) => j.override) ? (
        <ul className="flex flex-col gap-1 text-14 text-ink-2 wrap-anywhere">
          {n.judges
            .filter((j) => j.override)
            .map((j) => (
              <li key={j.id}>
                Override: {j.override!.mode === "include" ? "reinstated" : "left out"} {j.name}, “{j.override!.reason}”
              </li>
            ))}
        </ul>
      ) : null}
      {!resultsPublished && open > 0 ? (
        <p className="flex max-w-[860px] flex-wrap items-baseline gap-x-3 gap-y-1 border-l-[3px] border-flag-bar py-1 pl-3 text-14">
          <span className="font-medium">
            {open} {open === 1 ? "decision is" : "decisions are"} still open before the results can go out.
          </span>
          <Link href={`/organize/${eventSlug}#decisions-title`} className="underline underline-offset-4">
            Decide on the overview
          </Link>
        </p>
      ) : null}
    </header>
  );
}
