import Link from "next/link";
import { exportHref } from "@/lib/export-href";
import { plural } from "@/lib/format";
import { PULL_SHOWN_WITHIN, pullShare, type PairwiseRanking } from "@/server/dal";

// The organizer's Results tab in pairwise mode (JUDGING.md "Pairwise mode"): the
// Bradley-Terry ranking per track with its uncertainty, the two pulls the fit measured
// and took out, the judges flagged as coin flips, groups never compared with each other,
// and every project's receipt: each comparison that went into its place.

type Ranking = PairwiseRanking;
type Row = Ranking["tracks"][number]["rows"][number];

const pct = (v: number) => `${Math.round(v * 100)} %`;

/** One pull's card: the share of wins it gives between two equal projects, once it is measured. */
function PullCard({ pull, answers, what, done }: { pull: ReturnType<typeof pullShare>; answers: number; what: string; done: string }) {
  return (
    <div className="rounded-sm border border-rule bg-surface p-5">
      <p className="text-38 leading-none font-semibold tnum">{pull?.measured ? pct(pull.share) : "–"}</p>
      <p className="mt-2 text-14 text-ink-2">
        {!pull
          ? `No answers yet: ${what} is measured once judges answer.`
          : pull.measured
            ? `is how often ${done} (± ${pull.pm} points). The ranking takes this pull out.`
            : `Not measured yet: after ${plural(answers, "answer")}, ${what} is known only within ± ${pull.pm} points; it is shown once that is ${PULL_SHOWN_WITHIN} or less. Until then the fit assumes almost none.`}
      </p>
    </div>
  );
}

export function PairwiseResults({
  ranking: r,
  eventId,
  eventSlug,
  published,
  chosen,
}: {
  ranking: Ranking;
  eventId: string;
  eventSlug: string;
  published: boolean;
  chosen: string | null;
}) {
  const left = pullShare(r.left);
  const fresh = pullShare(r.fresh);
  const split = r.tracks.filter((t) => t.groups > 1);
  const open = r.flags.filter((f) => !f.resolved);
  const shown = r.tracks.filter((t) => !chosen || t.trackId === chosen);
  const ranked = r.tracks.reduce((n, t) => n + t.rows.filter((x) => x.comparisons > 0).length, 0);

  return (
    <>
      <header className="flex flex-col gap-3">
        <p className="label-mono text-ink-2">{published ? "Published run" : "Preview: nothing is public until you publish"}</p>
        <h1 className="text-24 font-semibold">The ranking and its working</h1>
        <p className="max-w-[860px] text-15 leading-6 wrap-anywhere">
          <strong>Pairwise: {r.method}.</strong> {plural(r.counts.picks, "answer")} from judges, plus {plural(r.counts.fromScores, "pair")} implied by
          scores given before the switch (a judge&rsquo;s scores in a track count as k − 1 answers together, and drop out for the pairs that judge has
          placed by answers). A project&rsquo;s win % is its chance to beat an average project of its track; ± is one standard error. Coin-flip rule: a judge
          with 6 or more answers who agrees with the rest of the panel no better than chance, or calls more than half of them too close, is flagged for
          you to keep or leave out, with a reason.
          {r.leftOut.length ? ` Left out of the fit: ${r.leftOut.join(", ")} (the flat-judge rule or your decision).` : " Nobody is left out of the fit."}
        </p>
        {r.flags.length ? (
          <ul className="flex flex-col gap-1 text-14 text-ink-2 wrap-anywhere">
            {r.flags.map((f) => (
              <li key={f.judgeId}>
                {f.resolved ? (
                  <>
                    Override: {f.resolved.mode === "include" ? "kept" : "left out"} {f.name}, &ldquo;{f.resolved.reason}&rdquo;
                  </>
                ) : (
                  <>
                    Flagged: {f.name}, {plural(f.picks, "answer")}
                    {f.why === "ties" ? `, ${f.ties} too close to call` : f.share !== null ? `, agrees with the panel ${pct(f.share)} of the time` : ""}.{" "}
                    <Link href={`/organize/${eventSlug}`} className="text-ink underline underline-offset-4">
                      Decide on Overview
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </header>

      <section aria-label="Findings" className="grid gap-6 wrap-anywhere lg:grid-cols-3">
        <PullCard pull={left} answers={r.counts.picks} what="the pull of the left side" done="the project shown on the left wins between two equal projects" />
        <PullCard
          pull={fresh}
          answers={r.counts.picks}
          what="the pull of the project just opened"
          done="the project a judge has just opened wins against an equal one already on their list"
        />
        <div className="rounded-sm border border-rule bg-surface p-5">
          <p className="text-38 leading-none font-semibold tnum">
            {ranked} of {r.tracks.reduce((n, t) => n + t.rows.length, 0)}
          </p>
          <p className="mt-2 text-14 text-ink-2">
            projects compared at least once.{" "}
            {split.length
              ? `${split.map((t) => `${t.name} splits into ${t.groups} groups`).join("; ")} never compared with each other: places compare only within a group.`
              : "Every track is one connected group, so every two places in a track can be compared."}
            {open.length ? ` ${plural(open.length, "judge")} flagged and waiting for your decision.` : ""}
          </p>
        </div>
      </section>

      <section aria-labelledby="table-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="table-title" className="text-17 font-semibold">
            Every project
          </h2>
          <a href={exportHref(eventId, "comparisons.csv")} className="text-13 underline underline-offset-4">
            comparisons.csv
          </a>
        </div>
        <nav aria-label="Tracks" className="flex flex-wrap gap-2">
          <Link
            href={`/organize/${eventSlug}/results`}
            aria-current={chosen === null ? "page" : undefined}
            className="rounded-sm border border-edge px-3 py-1 text-13 aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-surface"
          >
            All tracks
          </Link>
          {r.tracks.map((t) => (
            <Link
              key={t.trackId}
              href={`/organize/${eventSlug}/results?track=${t.trackId}`}
              aria-current={chosen === t.trackId ? "page" : undefined}
              className="rounded-sm border border-edge px-3 py-1 text-13 wrap-anywhere aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-surface"
            >
              {t.name}
            </Link>
          ))}
        </nav>
        {shown.map((t) => (
          <div key={t.trackId} className="flex flex-col gap-2">
            <h3 className="mt-3 text-15 font-semibold">
              {t.name}
              {t.groups > 1 ? <span className="ml-2 text-13 font-normal text-flag">{t.groups} groups never compared with each other</span> : null}
            </h3>
            <div className="overflow-x-auto rounded-sm border border-rule bg-surface">
              <table className="w-full text-14">
                <thead>
                  <tr className="border-b border-rule text-left text-13 text-ink-2">
                    <th className="px-3 py-2 font-medium">Place</th>
                    <th className="px-3 py-2 font-medium">Project</th>
                    <th className="px-3 py-2 text-right font-medium">Wins against the average</th>
                    <th className="px-3 py-2 text-right font-medium">Ahead of the next</th>
                    <th className="px-3 py-2 text-right font-medium">Plain win rate</th>
                    <th className="px-3 py-2 text-right font-medium">Comparisons</th>
                    <th className="px-3 py-2 font-medium">Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((p) => (
                    <ProjectRow key={p.projectId} p={p} split={t.groups > 1} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        <p className="text-13 text-ink-2">
          &ldquo;Ahead of the next&rdquo; is the chance this project really is better than the one placed right below it; under about 75 %, read the two
          places as a tie. The plain win rate (ties count half) is shown for comparison: it ignores the two pulls and who each project met.
        </p>
      </section>
    </>
  );
}

function ProjectRow({ p, split }: { p: Row; split: boolean }) {
  const compared = p.comparisons > 0;
  return (
    <tr className="border-b border-rule align-top last:border-b-0">
      <td className="px-3 py-2 tnum">
        {compared ? p.place : "–"}
        {split && compared ? <span className="ml-1 text-12 text-ink-3">group {p.group + 1}</span> : null}
      </td>
      <td className="px-3 py-2">
        <span className="font-medium">{p.title}</span>
        <span className="block text-12 text-ink-2">{p.teamName}</span>
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap tnum">
        {compared ? (
          <>
            {pct(p.winPct)} <span className="text-ink-2">± {Math.max(1, Math.round(p.winPctSe * 100))}</span>
          </>
        ) : (
          <span className="text-ink-2">not compared yet</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tnum">{p.beatsNext === null ? "–" : pct(p.beatsNext)}</td>
      <td className="px-3 py-2 text-right tnum">{p.winRate === null ? "–" : pct(p.winRate)}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap tnum">
        {p.comparisons}
        <span className="block text-12 text-ink-2">
          {plural(p.judges, "judge")}, {plural(p.picks, "answer")}
        </span>
      </td>
      <td className="px-3 py-2">
        {p.receipt.length ? (
          <details>
            <summary className="cursor-pointer text-13 whitespace-nowrap">{plural(p.receipt.length, "line")}</summary>
            <ul className="mt-2 flex max-h-64 min-w-[280px] flex-col gap-1 overflow-y-auto text-13">
              {p.receipt.map((l, n) => (
                <li key={n} className="wrap-anywhere">
                  <span className={l.result === "won" ? "text-ok" : l.result === "lost" ? "text-flag" : "text-ink-2"}>
                    {l.result === "tie" ? "too close" : l.result}
                  </span>{" "}
                  against {l.opponent} <span className="text-ink-2">({l.judge}, {l.kind === "pick" ? `an answer${l.side ? `, on the ${l.side}` : ""}` : `from scores, weight ${l.weight.toFixed(2)}`})</span>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <span className="text-13 text-ink-3">none</span>
        )}
      </td>
    </tr>
  );
}
