import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { LeniencyStrip } from "@/components/figures/leniency-strip";
import { RankLine, SlopeChart } from "@/components/figures/slope-chart";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { guardPage } from "@/lib/page-guard";
import { formatUtc, plural } from "@/lib/format";
import { currentActor, getNormalization, listRecords, METHOD_LABEL, type ProjectRow } from "@/server/dal";
import { issueEveryRecord } from "../../../records/actions";
import { JudgeLedger } from "./judge-ledger";
import { exportHref } from "@/lib/export-href";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Results and their working" };

const f2 = (v: number | null) => (v === null ? "–" : v.toFixed(2));
const rk = (v: number | null) => (v === null ? "–" : Number.isInteger(v) ? String(v) : v.toFixed(1));
/** Signed to two decimals; a value that rounds to zero shows as 0.00, never −0.00. */
const signed = (v: number) => (Math.abs(v) < 0.005 ? "0.00" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`);

function Move({ p }: { p: ProjectRow }) {
  if (p.rankRaw === null || p.rankNormalized === null) return <span className="text-ink-3">–</span>;
  const d = p.rankRaw - p.rankNormalized;
  if (Math.abs(d) < 1) return <span className="text-ink-3">–</span>;
  return <span className={d > 0 ? "text-ok" : "text-flag"}>{d > 0 ? `▲ ${rk(d)}` : `▼ ${rk(-d)}`}</span>;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The change from raw, split into what leaving judges out did and what the leniency correction did. */
function Change({ p }: { p: ProjectRow }) {
  if (p.score === null || p.rawAll === null || p.rawKept === null) return null;
  const out = p.rawKept - p.rawAll;
  const lean = p.score - p.rawKept;
  return (
    <p className="mt-1 text-13 text-ink-2">
      Change from raw: {f2(p.rawAll)} with every judge → {f2(p.score)} normalized
      {Math.abs(p.score - p.rawAll) < 0.005
        ? ", no change at two decimals"
        : Math.abs(out) >= 0.005
          ? `, ${signed(p.score - p.rawAll)}: ${signed(out)} from leaving judges out, ${signed(lean)} from leniency`
          : `, ${signed(p.score - p.rawAll)}, all of it from leniency`}
      .
    </p>
  );
}

export default async function ResultsWorkingPage({ params, searchParams }: PageProps<"/organize/[event]/results">) {
  const { event: key } = await params;
  const { track } = await searchParams;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, normalization: n, decisions, notes } = guardPage(() => getNormalization(actor, key));
  const tracks = [...new Map(n.projects.map((p) => [p.trackId, p.trackName])).entries()];
  const chosen = typeof track === "string" && tracks.some(([id]) => id === track) ? track : null;
  const rows = n.projects.filter((p) => !chosen || p.trackId === chosen);
  const flat = decisions.find((d) => d.kind === "flat_judge");
  const dup = decisions.find((d) => d.kind === "duplicate");
  const excludedNames = n.judges.filter((j) => j.excluded).map((j) => j.name);
  const slope = n.projects
    .filter((p) => p.rankRaw !== null && p.rankKept !== null)
    .map((p) => ({ id: p.id, title: p.title, from: p.rankRaw!, to: p.rankKept! }));
  const moverByExclusion = slope.reduce<(typeof slope)[number] | null>((m, r) => (!m || Math.abs(r.to - r.from) > Math.abs(m.to - m.from) ? r : m), null);
  const movedByExclusion = slope.filter((r) => Math.abs(r.to - r.from) >= 1).length;
  const kept = n.judges.filter((j) => !j.excluded && j.n > 0);
  const points = kept.filter((j) => j.tilt !== null).map((j) => ({ name: j.name, n: j.n, tilt: j.tilt!, leniency: j.leniency }));
  const maxLeniency = kept.reduce((m, j) => Math.max(m, Math.abs(j.leniency)), 0);
  const copies = dup?.kind === "duplicate" ? dup.copies.filter((c) => c.rankRaw !== null).sort((a, b) => a.rankRaw! - b.rankRaw!) : [];
  const records = event.resultsPublishedAt ? listRecords(actor, key) : [];

  return (
    <WorkShell eventName={event.name} eventHref={`/organize/${event.slug}`} tabs={organizerTabs(event.slug, "Results")} person={actor.name} role="Organizer">
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-3">
          <p className="label-mono text-ink-2">{event.resultsPublishedAt ? "Published run" : "Preview: nothing is public until you publish"}</p>
          <h1 className="text-24 font-semibold">The ranking and its working</h1>
          <p className="max-w-[860px] text-15 leading-6 wrap-anywhere">
            <strong>{METHOD_LABEL}.</strong>{" "}
            {!n.variance.measured
              ? "No project has two counted reviews yet, so this run cannot measure leniency or review noise: it ranks by the plain mean of each project's reviews, with no ±."
              : n.variance.k === null
              ? "This run found no steady leniency (β̂² = 0), so it ranks by the plain mean of each project's counted reviews."
              : `This run: k = ${n.variance.k.toFixed(1)} (β̂² = ${n.variance.beta2.toFixed(3)}, σ̂² = ${n.variance.sigma2.toFixed(3)}), so a judge needs ${plural(Math.round(n.variance.k), "review")} before half their tilt counts.`}{" "}
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
        </header>

        <section aria-label="Findings" className="grid gap-6 wrap-anywhere lg:grid-cols-3">
          <div className="rounded-sm border border-rule bg-surface p-5">
            <p className="text-38 leading-none font-semibold tnum">
              {movedByExclusion} of {slope.length}
            </p>
            <p className="mt-2 text-14 text-ink-2">
              {excludedNames.length
                ? `projects move when ${excludedNames.join(" and ")} ${excludedNames.length === 1 ? "is" : "are"} left out${moverByExclusion ? `; the largest: ${moverByExclusion.title}, ${rk(moverByExclusion.from)} → ${rk(moverByExclusion.to)}` : ""}.`
                : "projects move from leaving judges out: nobody is left out."}
            </p>
            {excludedNames.length ? (
              <div className="mt-4">
                <SlopeChart rows={slope} total={slope.length} highlight={moverByExclusion?.id ?? null} label="Each project's rank with all judges against its rank without the excluded ones" />
              </div>
            ) : null}
          </div>
          <div className="rounded-sm border border-rule bg-surface p-5">
            <p className="text-38 leading-none font-semibold tnum">±{maxLeniency.toFixed(2)}</p>
            <p className="mt-2 text-14 text-ink-2">
              is the largest leniency the data supports.{" "}
              {n.variance.k !== null ? `At k = ${n.variance.k.toFixed(1)} a judge needs ${plural(Math.round(n.variance.k), "review")} before half their tilt counts.` : ""}
            </p>
            <div className="mt-4">
              <LeniencyStrip points={points} label="Leniency per judge: plain average against what the data supports" />
            </div>
          </div>
          <div className="rounded-sm border border-rule bg-surface p-5">
            {copies.length >= 2 && dup?.kind === "duplicate" ? (
              <>
                <p className="text-38 leading-none font-semibold tnum">
                  {copies.map((c) => rk(c.rankRaw)).join(" and ")}
                </p>
                <p className="mt-2 text-14 text-ink-2">
                  are the raw ranks of the same project, {dup.title}, entered twice: the measured noise floor. Read neighbouring ranks as ties; the results page shows
                  scores next to places.
                </p>
                <div className="mt-4">
                  <RankLine total={n.ranked} marks={copies.map((c) => ({ rank: c.rankRaw!, text: rk(c.rankRaw) }))} label={`Raw ranks of the two copies of ${dup.title}`} />
                </div>
              </>
            ) : null}
            {n.signal ? (
              <div className={copies.length >= 2 ? "mt-6 border-t border-rule pt-4" : ""}>
                <p className="text-14">
                  <strong>Signal check: permutation share {n.signal.share.toFixed(3)}.</strong>{" "}
                  {n.signal.share > 0.05
                    ? `Shuffling the review totals spreads the projects at least as far apart as the real scores in ${Math.round(n.signal.share * 100)} % of ${n.signal.trials.toLocaleString("en")} shuffles, so these scores cannot tell the projects apart better than chance.`
                    : `Shuffling the review totals almost never spreads the projects as far apart as the real scores (${Math.round(n.signal.share * 100)} % of ${n.signal.trials.toLocaleString("en")} shuffles): the projects really differ.`}
                </p>
                <svg viewBox="0 0 320 30" className="mt-3 w-full max-w-[360px]" role="img" aria-label={`Permutation share ${n.signal.share.toFixed(3)} on a scale from 0 to 1, with the 0.05 line`}>
                  <rect x={10} y={12} width={300} height={4} className="fill-sunken" />
                  <line x1={10 + 0.05 * 300} x2={10 + 0.05 * 300} y1={6} y2={22} className="stroke-flag-bar" strokeWidth={1.5} />
                  <circle cx={10 + n.signal.share * 300} cy={14} r={5} className="fill-ink" />
                  <text x={10 + 0.05 * 300 + 4} y={28} className="fill-ink-3 text-[9px]">0.05</text>
                </svg>
              </div>
            ) : null}
            {copies.length >= 2 && dup?.kind === "duplicate" ? null : (
              <>
                <p className="text-38 leading-none font-semibold tnum">{n.ranked}</p>
                <p className="mt-2 text-14 text-ink-2">projects ranked. Read neighbouring ranks as ties; the results page shows scores next to places.</p>
              </>
            )}
          </div>
        </section>

        <section aria-labelledby="table-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="table-title" className="text-17 font-semibold">
              Every project
            </h2>
            <a href={exportHref(event.id, "normalized.csv")} className="text-13 underline underline-offset-4">
              normalized.csv
            </a>
          </div>
          <nav aria-label="Tracks" className="flex flex-wrap gap-2">
            <Link
              href={`/organize/${event.slug}/results`}
              aria-current={chosen === null ? "page" : undefined}
              className="rounded-sm border border-edge px-3 py-1 text-13 aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-surface"
            >
              All {n.projects.length}
            </Link>
            {tracks.map(([id, name]) => {
              const moved = n.projects.filter((p) => p.trackId === id && p.rankRaw !== null && p.rankNormalized !== null && Math.abs(p.rankRaw - p.rankNormalized) >= 1).length;
              return (
                <Link
                  key={id}
                  href={`/organize/${event.slug}/results?track=${id}`}
                  aria-current={chosen === id ? "page" : undefined}
                  className="rounded-sm border border-edge px-3 py-1 text-13 wrap-anywhere aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-surface"
                >
                  {name}
                  {moved ? <span className="ml-1 text-ink-3">· {moved} moved</span> : null}
                </Link>
              );
            })}
          </nav>
          <div className="overflow-x-auto rounded-sm border border-rule bg-surface">
            <table className="w-full text-14">
              <thead>
                <tr className="border-b border-rule text-left text-13 text-ink-2">
                  <th className="px-3 py-2 font-medium">Rank</th>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">{chosen ? "In track" : "Track"}</th>
                  <th className="px-3 py-2 text-right font-medium">Reviews</th>
                  <th className="px-3 py-2 text-right font-medium">Raw, all judges</th>
                  <th className="px-3 py-2 text-right font-medium">Raw, counted</th>
                  <th className="px-3 py-2 text-right font-medium">Normalized</th>
                  <th className="px-3 py-2 text-right font-medium">Move</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b border-rule align-top last:border-b-0">
                    <td className="px-3 py-2 tnum">{p.duplicateOf ? "–" : rk(chosen ? p.trackRank : p.rankNormalized)}</td>
                    <td className="px-3 py-2">
                      <details>
                        <summary className="cursor-pointer">
                          <span className="font-medium">{p.title}</span> <span className="font-mono text-12 text-ink-3">{p.id}</span>
                          {p.duplicateOf ? <span className="ml-2 text-12 text-ink-2">merged into {p.duplicateOf}</span> : null}
                          {p.underReviewed ? <span className="ml-2 text-12 text-flag">under-reviewed</span> : null}
                        </summary>
                        {p.receipts.length ? (
                          <div className="mt-3 mb-1 rounded-sm bg-sunken p-3">
                            <table className="text-13">
                              <thead>
                                <tr className="text-left text-ink-2">
                                  <th className="pr-4 font-medium">Judge</th>
                                  <th className="pr-4 text-right font-medium">Review</th>
                                  <th className="pr-4 text-right font-medium">Leniency</th>
                                  <th className="text-right font-medium">Adjusted</th>
                                </tr>
                              </thead>
                              <tbody>
                                {p.receipts.map((r) => (
                                  <tr key={r.judgeId} className={r.excluded ? "text-ink-3 line-through" : ""}>
                                    <td className="pr-4">{r.judge}</td>
                                    <td className="pr-4 text-right tnum">{f2(r.y)}</td>
                                    <td className="pr-4 text-right tnum">{r.excluded ? "left out" : signed(r.leniency)}</td>
                                    <td className="text-right tnum">{r.excluded ? "–" : f2(r.adjusted)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {p.score !== null ? (
                              <>
                                <p className="mt-2 font-mono text-12 text-ink-2">
                                  ({p.receipts.filter((r) => !r.excluded).map((r) => f2(r.adjusted)).join(" + ")}) ÷ {p.n} = {f2(p.score)}
                                </p>
                                <Change p={p} />
                                {notes.some((x) => x.projectId === p.id) ? (
                                  <div className="mt-2 border-t border-rule pt-2">
                                    <p className="text-12 font-medium text-ink-2">Private notes to the organizers, never shown to the team</p>
                                    <ul className="mt-1 flex flex-col gap-1 text-13">
                                      {notes
                                        .filter((x) => x.projectId === p.id)
                                        .map((x) => (
                                          <li key={x.judgeId}>
                                            <span className="font-medium">{x.judge}:</span> {x.note}
                                          </li>
                                        ))}
                                    </ul>
                                  </div>
                                ) : null}
                                {p.se !== null ? (
                                  <p className="mt-1 text-13 text-ink-2">
                                    ± {f2(p.se)}: one standard error, from σ̂² = {n.variance.sigma2.toFixed(3)}, the {p.n} counted {p.n === 1 ? "review" : "reviews"} and
                                    how well their judges&rsquo; leniency is known. Scores closer than about two of these are not told apart.
                                  </p>
                                ) : null}
                              </>
                            ) : null}
                          </div>
                        ) : (
                          <p className="mt-2 text-13 text-ink-2">{p.duplicateOf ? "Its reviews count toward the copy it was merged into." : "No finished review yet."}</p>
                        )}
                      </details>
                    </td>
                    <td className="px-3 py-2 text-13 text-ink-2">{chosen ? `${rk(p.trackRankRaw)} → ${rk(p.trackRank)}` : p.trackName}</td>
                    <td className="px-3 py-2 text-right tnum">{p.n === p.nAll ? p.n : `${p.n} of ${p.nAll}`}</td>
                    <td className="px-3 py-2 text-right tnum">
                      {f2(p.rawAll)} <span className="text-12 text-ink-3">#{rk(p.rankRaw)}</span>
                    </td>
                    <td className="px-3 py-2 text-right tnum">{f2(p.rawKept)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tnum">
                      <span className="font-semibold">{f2(p.score)}</span>
                      {p.se !== null ? <span className="ml-1 text-12 text-ink-3">±{f2(p.se)}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tnum">{p.duplicateOf ? "" : <Move p={p} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-13 text-ink-2">
            Ranks are average ranks for ties (so 17.5 means two projects share 17th and 18th). A move under one place is a tie being split and shows as a dash.
            Normalized ranks compare within a track; tracks compare only through judges who score in both.
          </p>
        </section>

        <JudgeLedger n={n} eventSlug={event.slug} published={Boolean(event.resultsPublishedAt)} />

        {flat?.kind === "flat_judge" && !flat.resolved ? (
          <p className="text-14">
            <Link href={`/organize/${event.slug}`} className="underline underline-offset-4">
              Back to the decisions
            </Link>{" "}
            : {decisions.filter((d) => !d.resolved).length} still open before results can go out.
          </p>
        ) : null}

        <section aria-labelledby="records-title" className="flex flex-col gap-4 border-t border-rule pt-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 id="records-title" className="text-20 font-semibold">
                Certificates and judging records
              </h2>
              <p className="mt-1 max-w-[720px] text-14 text-ink-2">
                {event.resultsPublishedAt
                  ? `Each is signed with the portal's Ed25519 key, so anyone holding one can check it is real. People can also fetch their own: judges from the console, team members from their project page. ${count(records.filter((r) => r.kind === "judge").length, "judging record")} and ${count(records.filter((r) => r.kind === "participant").length, "certificate")} issued so far. A record keeps the names it was issued with, so issue them once people have claimed their accounts and set their names.`
                  : "Once the results are published, every judge with a finished review can get a signed judging record and every member of a submitting team a signed certificate."}
              </p>
            </div>
            {event.resultsPublishedAt ? (
              <form action={issueEveryRecord.bind(null, event.slug)}>
                <button className="inline-flex h-9 items-center rounded-sm bg-primary px-4 text-14 font-medium text-on-primary hover:opacity-90">
                  Issue every record
                </button>
              </form>
            ) : null}
          </div>
          {records.length ? (
            <div className="max-h-[480px] overflow-y-auto rounded-sm border border-rule">
              <table className="w-full text-14">
                <thead className="sticky top-0 bg-surface text-left text-13 text-ink-2">
                  <tr>
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Record</th>
                    <th className="px-3 py-2 font-medium max-sm:hidden">Issued (UTC)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {records.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2">{r.name}</td>
                      <td className="px-3 py-2">
                        <Link href={`/records/${r.id}`} className="underline underline-offset-4">
                          {r.kind === "judge" ? "Judging record" : "Certificate"}
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-mono text-12 text-ink-2 max-sm:hidden">{formatUtc(r.issuedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
    </WorkShell>
  );
}
