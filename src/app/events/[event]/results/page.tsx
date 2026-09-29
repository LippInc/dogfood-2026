import type { Metadata } from "next";
import type { CSSProperties } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { notFound } from "next/navigation";
import { Face } from "@/components/face";
import { LogSeal } from "@/components/results/log-seal";
import { mostlyFromScores, pairwiseSources, RankingEvidence, winPctMethod } from "@/components/results/ranking-evidence";
import { VoteCountChanges, VoteRuleChanges } from "@/components/results/vote-rule-changes";
import { ScaleAxis, ScoreLine, scaleFor } from "@/components/results/score-line";
import { PublicShell } from "@/components/shell/public-shell";
import { YardstickLine } from "@/components/yardstick-line";
import { movesByProject, RowChangeMarks, TieBreakChangesNotice, tieBrokenByOf, TrackMovesNotice, WeightChangesNotice } from "@/components/results/after-the-fact";
import { formatUtc, plural } from "@/lib/format";
import { actorNav, currentActor, getCommunityResults, getGallery, getPublishedResults, NotFoundError, PAIRWISE_METHOD, publishedPrizes, type Gallery } from "@/server/dal";
import { PrizeWinners } from "@/components/results/prize-winners";
import { competitionPlaces, ordinal, tieDecided } from "@/lib/places";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Results" };

function load(key: string): Gallery {
  try {
    return getGallery(key);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

const two = (n: number) => String(n).padStart(2, "0");

// The row grid, shared by the axis above a track and every row in it, so the figure column lines up.
// On a wide screen the scale takes the room the short titles leave, so a ± bar reads at a glance.
const ROW =
  "grid grid-cols-[56px_minmax(0,1fr)_auto] gap-x-4 md:grid-cols-[72px_64px_minmax(0,1fr)_minmax(160px,280px)_112px] lg:grid-cols-[72px_64px_minmax(200px,1fr)_minmax(280px,560px)_120px]";

export default async function ResultsPage({ params }: PageProps<"/events/[event]/results">) {
  const { event: key } = await params;
  const { event, counts, tracks: galleryTracks } = load(key);
  const actor = await currentActor();
  const results = getPublishedResults(event.id);
  const community = getCommunityResults(event.id);
  // [] until published, and when no prize was awarded: the page is then as it was before prizes could be given
  const prizes = publishedPrizes(event.id);
  // the open link's column shows only when some of its ballots are in the count's rows
  const linkVotes = Boolean(community.tally?.some((t) => t.openLink > 0));
  const pairwise = results.published && results.method === PAIRWISE_METHOD;
  // where a pairwise ranking's comparisons came from, answers and pairs implied by scores counted apart (the evidence block's words)
  const pw = results.published && results.evidence.kind === "pairwise" ? results.evidence : null;
  const pwMostly = pw ? mostlyFromScores(pw) : null;

  const fmtScore = (v: number | null) => (v === null ? "–" : pairwise ? `${Math.round(v * 100)} %` : v.toFixed(2));
  const fmtSe = (v: number | null) => (v === null ? "" : pairwise ? `± ${Math.max(1, Math.round(v * 100))}` : `± ${v.toFixed(2)}`);
  const fmtN = (n: number) => `${n} ${pairwise ? (n === 1 ? "judge" : "judges") : n === 1 ? "review" : "reviews"}`;

  const placed = results.published ? results.tracks.map((t) => ({ ...t, places: competitionPlaces(t.rows) })) : [];
  const scale = scaleFor(
    placed.flatMap((t) =>
      t.rows.flatMap((r) => (r.score === null ? [] : [r.score - (r.se ?? 0), r.score + (r.se ?? 0), ...(!pairwise && r.raw !== null ? [r.raw] : [])])),
    ),
    Boolean(pairwise),
  );
  const winners = placed.flatMap((t, ti) => {
    const firsts = t.rows.filter((_, i) => t.places[i]?.place === 1);
    return firsts.length ? [{ track: t, index: ti, first: firsts[0], joint: firsts.slice(1) }] : [];
  });
  const placedCount = placed.reduce((n, t) => n + t.rows.length, 0);
  // Moves the published run recorded, per project: a move can change a track's winner, so each shows next to its project.
  const movesOf = movesByProject(results.published ? results.trackMoves : []);
  const movedCount = placed.reduce((n, t) => n + t.rows.filter((r) => movesOf.has(r.projectId)).length, 0);
  const underReviewed = placed.some((t) => t.rows.some((r) => r.n < 2));
  // The plain words, one point each; the same sentences the page said as one paragraph.
  const readingPoints: string[] = [
    "Places compare within a track.",
    pairwise
      ? pw?.fromScores
        ? `Each project’s win % is its chance to beat an average project of its track, fitted from ${pairwiseSources(pw)}.${pwMostly ? ` ${pwMostly}` : ""}`
        : "Judges compared projects they were given, two at a time; each project’s win % is its chance to beat an average project of its track."
      : results.published && results.k !== null
        ? "Each score is the judges’ weighted rubric average, evened out for judges who score higher or lower than the rest."
        : "Each score is the plain average of the judges’ weighted rubric totals: no judge’s leniency was taken out.",
    "Read gaps smaller than about two margins of error (two ±) as ties.",
    ...(underReviewed
      ? [
          pairwise
            ? "A project marked under-compared was compared by fewer than two judges; the organizers chose to publish it as it is."
            : "A project marked under-reviewed had fewer than the two reviews a fair score needs; the organizers chose to publish it as it is.",
        ]
      : []),
  ];
  // a project with a counted vote (or an open-link one, shown apart) gets a row; the rest are named in one fold
  const voted = community.tally?.filter((t) => t.votes > 0 || t.openLink > 0) ?? [];
  const unvoted = community.tally?.filter((t) => t.votes === 0 && t.openLink === 0) ?? [];
  const topVotes = community.tally?.reduce((m, t) => Math.max(m, t.votes), 0) ?? 0;

  return (
    <PublicShell event={event} active="results" signedInAs={actor?.name ?? null} links={actorNav(actor, event.id)}>
      {results.published ? (
        <>
          {/* wide screen: the plain words on the left; the seal, then the method's fold, beside them, so no dead ground opens up there */}
          <div className="grid gap-8 pt-10 lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-[auto_1fr] lg:gap-x-16 lg:gap-y-0">
            <div className="lg:col-start-1 lg:row-span-2 lg:row-start-1">
              <h1 className="font-display text-[48px] leading-[52px] md:text-64">Results</h1>
              <p className="label-mono mt-3 tnum text-ink-3">
                Published {formatUtc(results.publishedAt)} · {plural(placedCount, "place")} in {plural(placed.length, "track")} ·{" "}
                <a href="#how-reached" className="underline underline-offset-4 hover:text-accent-ink">
                  How this ranking was reached
                </a>
              </p>
              {pairwise ? null : <p className="mt-2 text-15 text-ink-2"><Link href={`/events/${event.slug}/results/overall`} className="underline underline-offset-4 hover:text-accent-ink">Every project in one order, across tracks</Link></p>}
              {/* Plain words on top, one point to a line; the method, word for word, one click away (decided 2026-09-27 21:09 NL). */}
              <ol aria-label="How to read these results" className="mt-6 max-w-[760px] border-b border-rule text-17">
                {readingPoints.map((point, i) => (
                  <li key={i} className="grid grid-cols-[36px_minmax(0,1fr)] items-baseline border-t border-rule py-2.5">
                    <span className="font-mono text-12 tnum text-ink-3">{two(i + 1)}</span>
                    <span className={i === readingPoints.length - 1 && underReviewed ? "text-ink-2" : "text-ink"}>{point}</span>
                  </li>
                ))}
              </ol>
              {results.unsettled ? (
                <div className="mt-6 max-w-[760px] border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-15 text-flag">
                  <p className="font-semibold">The ranking fit had not settled when these results were published.</p>
                  <p className="mt-1.5">
                    It stopped after {results.unsettled.iterations} steps, so the win % could still have moved. The organizers published it anyway. Their
                    reason: &ldquo;{results.unsettled.reason}&rdquo;
                  </p>
                </div>
              ) : null}
              <WeightChangesNotice changes={results.weightChanges} className="mt-6" />
              <TieBreakChangesNotice changes={results.tieBreakChanges} className="mt-6" />
              <TrackMovesNotice count={movedCount} className="mt-6" />
            </div>
            <details className="group max-w-[760px] self-start rounded-sm border border-rule text-ink-2 lg:col-start-2 lg:row-start-2 lg:mt-6">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 flex-1">
                  <span className="block text-15 font-semibold text-ink">How these {pairwise ? "win %" : "scores"} were made</span>
                  <span className="block text-13 text-ink-3">
                    {results.yardstick ? "The method, the margin of error (±), and how far apart the judges were" : "The method in full, and the margin of error (±)"}
                  </span>
                </span>
                <ChevronDown className="size-4 shrink-0 text-ink-2 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
              </summary>
              <div className="flex flex-col gap-3 border-t border-rule px-4 pt-3 pb-4">
                {/* what the figures below mean for the places, in one plain sentence; the step-by-step lives in its own block, not here */}
                <p className="text-ink">
                  What this means for the places: a project ahead of the next by less than about two ± could as well have been behind it, and the
                  figures below measure that margin; each step, project by project, is under{" "}
                  <a href="#how-reached" className="underline underline-offset-4 hover:text-accent-ink">
                    How this ranking was reached
                  </a>
                  .
                </p>
                {pairwise ? (
                  <p>{winPctMethod(pw)}</p>
                ) : (
                  <p>
                    {results.k !== null
                      ? `Each project’s score is its judges’ weighted rubric average, adjusted for how lenient each judge proved to be across the event (k = ${results.k.toFixed(1)}).`
                      : "Each project’s score is the plain average of its judges’ weighted rubric totals: the reviews showed no steady leniency to take out, or were too few to measure one."}{" "}
                    The ± under each score is one standard error: scores closer than about two of them are not told apart.
                  </p>
                )}
                {results.yardstick ? (
                  // the shared drawing paints its band in --sunken, which all but vanishes on the public dark ground; here it takes the hairline colour
                  <div className="[&_svg_rect]:fill-rule">
                    <YardstickLine y={results.yardstick} figure />
                    {/* the small drawing's key, in the marks it uses */}
                    <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-13 text-ink-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block size-2.5 rounded-full bg-ink" aria-hidden /> the judges&rsquo; spread
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block size-2.5 rounded-full border-[1.5px] border-ink" aria-hidden /> after the engine
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-2.5 w-5 bg-rule" aria-hidden /> where luck alone lands, 9 times in 10
                      </span>
                    </p>
                  </div>
                ) : null}
              </div>
            </details>
            {/* the seal: beside the title on a wide screen; on a phone after the first places, which a visitor came for */}
            {results.anchor ? (
              <div className="order-last lg:order-none lg:col-start-2 lg:row-start-1 lg:self-start lg:pt-4">
                <LogSeal
                  entry={results.anchor.entry}
                  hash={results.anchor.hash}
                  what="What this proves: the results were published as this entry of the portal’s audit log, and the hash seals every entry up to it. Had anyone changed an earlier entry afterwards (a score, a decision, these results), the log would no longer lead to this hash, and the picture drawn from it would differ."
                />
              </div>
            ) : null}
            {winners.length ? (
              <section aria-labelledby="firsts-title" className="mt-6 border-t border-rule pt-6 lg:col-span-2 lg:mt-14">
                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                  <h2 id="firsts-title" className="label-mono text-ink">
                    Fig. 01 — First places
                  </h2>
                  <p className="text-13 text-ink-3">One per track. Each opens its track below.</p>
                </div>
                {/* two to a row even on a phone, the face on top at every width: the winners read as a podium, not a list of small cards */}
                <ol className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-4">
                  {winners.map((w) => (
                    <li key={w.track.id} className="reveal" style={{ "--i": w.index } as CSSProperties}>
                      <a href={`#track-${w.track.id}`} className="tile lit group block border-t-2 border-accent pt-2">
                        <span className="flex items-baseline gap-2 text-13 text-ink-2">
                          <span className="font-mono text-12 tnum text-ink-3">{two(w.index + 1)}</span>
                          <span className="truncate">{w.track.name}</span>
                        </span>
                        <span className="mt-3 grid gap-2.5">
                          <span className="block overflow-hidden rounded-xs border border-rule">
                            <Face id={w.first.projectId} cols={32} rows={18} />
                          </span>
                          <span className="min-w-0 wrap-anywhere">
                            <span className="block font-display text-17 leading-tight group-hover:underline lg:text-20">{w.first.title}</span>
                            <span className="mt-0.5 block text-13 text-ink-2">{w.first.teamName}</span>
                            <span className="mt-1.5 block text-13 tnum">
                              <span className="text-15 font-semibold">{fmtScore(w.first.score)}</span> <span className="text-ink-2">{fmtSe(w.first.se)}</span>
                            </span>
                          </span>
                        </span>
                        {w.joint.length ? <span className="mt-2 block text-13 text-ink-2">Joint first with {w.joint.map((j) => j.title).join(", ")}</span> : null}
                        {tieDecided(w.first, { place: 1, joint: w.joint.length > 0 }) && results.published && results.tieBreak ? (
                          <span className="mt-2 block text-13 text-ink-2">Tied on score; tie broken by {results.tieBreak.criterion}</span>
                        ) : null}
                      </a>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
          </div>

          <PrizeWinners
            eventSlug={event.slug}
            prizes={prizes}
            places={Object.fromEntries(placed.flatMap((t) => t.rows.map((r, i) => [r.projectId, t.places[i]!.place === null ? "not placed" : `${t.places[i]!.joint ? "joint " : ""}${ordinal(t.places[i]!.place!)}`])))}
          />

          <section aria-labelledby="scale-title" className="mt-16 border-t border-rule pt-6">
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
              <h2 id="scale-title" className="label-mono text-ink">
                Fig. 02 — Every place, on one scale
              </h2>
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-13 text-ink-2">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block size-2.5 rounded-full bg-ink" aria-hidden /> {pairwise ? "win %" : "the published score"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="relative inline-block h-2 w-5 border-x border-ink-3" aria-hidden>
                    <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-ink-3" />
                  </span>
                  ± one standard error
                </span>
                {pairwise ? null : (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block size-3.5 rounded-full border-[1.5px] border-ink-2" aria-hidden /> the plain average of every review, before leniency
                  </span>
                )}
                <span>Where two bars overlap, read the places as a tie.</span>
              </p>
            </div>
          </section>

          <div className="mt-8 flex flex-col gap-14">
            {placed.map((t, ti) => (
              <section key={t.id} id={`track-${t.id}`} aria-labelledby={`track-title-${t.id}`} className="scroll-mt-6">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b-2 border-ink pb-2">
                  <span className="label-mono tnum text-ink-3">
                    Track {two(ti + 1)} / {two(placed.length)}
                  </span>
                  <h2 id={`track-title-${t.id}`} className="text-24 font-semibold wrap-anywhere">
                    {t.name}
                  </h2>
                  <span className="label-mono ml-auto text-ink-3">{plural(t.rows.length, "project")}</span>
                </div>
                <div className={`${ROW} pt-3`} aria-hidden="true">
                  <span className="col-start-2 col-span-2 max-md:pr-3 md:col-start-4 md:col-span-1">
                    <ScaleAxis scale={scale} />
                  </span>
                </div>
                <ol className="divide-y divide-rule">
                  {t.rows.map((r, i) => {
                    const p = t.places[i]!;
                    const first = p.place === 1;
                    return (
                      <li
                        key={r.projectId}
                        className={`reveal tile ${ROW} items-center gap-y-2 py-3 ${first ? "lit" : ""}`}
                        style={{ "--i": ti + i } as CSSProperties}
                      >
                        <span className={`font-display tnum ${first ? "text-38 text-accent-ink" : "text-24"}`}>
                          {p.place === null ? "–" : p.place}
                          {p.joint ? <span className="ml-1 align-top font-sans text-12 text-ink-2">joint</span> : null}
                        </span>
                        <span className="max-md:hidden">
                          <Face id={r.projectId} cols={32} rows={18} className="block h-9 w-16" />
                        </span>
                        <span className="min-w-0">
                          <Link href={`/events/${event.slug}/projects/${r.projectId}`} className="block truncate text-17 font-semibold hover:underline">
                            {r.title}
                          </Link>
                          <span className="block truncate text-14 text-ink-2">
                            {r.teamName}
                            {/* the track's heading already says where; the place in words stays for screen readers */}
                            {p.place !== null ? <span className="sr-only">{` · ${ordinal(p.place)} in ${t.name}`}</span> : null}
                          </span>
                          <RowChangeMarks
                            projectHref={`/events/${event.slug}/projects/${r.projectId}`}
                            teamChangedAt={r.teamChangedAt}
                            tieBrokenBy={results.published ? tieBrokenByOf(r, results.tieBreak) : null}
                            moves={movesOf.get(r.projectId)}
                          />
                        </span>
                        <span className="col-start-2 col-span-2 row-start-2 max-md:pr-3 md:col-start-4 md:col-span-1 md:row-start-1">
                          <ScoreLine scale={scale} score={r.score} se={r.se} raw={pairwise ? null : r.raw} first={first} index={ti + i} />
                        </span>
                        <span className="col-start-3 row-start-1 text-right md:col-start-5">
                          <span className="block text-20 font-semibold tnum">{fmtScore(r.score)}</span>
                          <span className="block text-12 text-ink-2 tnum">
                            {r.se !== null ? `${fmtSe(r.se)} · ` : ""}
                            {fmtN(r.n)}
                          </span>
                          {r.n < 2 ? <span className="block text-12 text-flag">{pairwise ? "under-compared" : "under-reviewed"}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
          <RankingEvidence results={results} />
        </>
      ) : (
        <>
          <div className="pt-10">
            <h1 className="font-display text-[48px] leading-[52px] md:text-64">Results</h1>
          </div>
          <section className="mt-10 grid gap-10 border-t border-rule pt-8 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)] lg:gap-16" aria-labelledby="hidden-title">
            <div>
              <p className="label-mono text-accent-ink">Not yet published</p>
              <h2 id="hidden-title" className="mt-3 text-24 font-semibold">
                The results are hidden until the organizers publish them
              </h2>
              <p className="mt-3 text-17 text-ink-2">
                Judging covers {plural(counts.projects, "project")} in {plural(counts.tracks, "track")}. Until the organizers publish, no score, average or rank
                leaves the judges&apos; and organizers&apos; screens, and the API refuses to hand them out. When they publish, this page shows each place with
                its score.
              </p>
            </div>
            {galleryTracks.length ? (
              <figure aria-labelledby="sealed-caption">
                <figcaption id="sealed-caption" className="label-mono text-ink">
                  Fig. 01 — {plural(counts.projects, "place")}, sealed
                </figcaption>
                <div className="mt-4 grid grid-cols-4 gap-x-3 gap-y-6 xl:grid-cols-8" aria-hidden="true">
                  {galleryTracks.map((t) => (
                    <div key={t.id}>
                      <p className="line-clamp-2 min-h-12 border-t-2 border-ink pt-2 text-13 leading-5 text-ink-2">{t.name}</p>
                      <div className="mt-2 grid gap-1">
                        {Array.from({ length: t.count }, (_, i) => (
                          <span key={i} className="sealed flex h-5 items-center rounded-xs border border-rule px-1.5 font-mono text-12 leading-none text-ink-3">
                            {i + 1}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </figure>
            ) : null}
          </section>
        </>
      )}
      {community.state === "not_set" ? null : (
        <section aria-labelledby="community-title" className="mt-20 max-w-[860px] border-t border-rule pt-8 pb-16">
          <p className="label-mono text-accent-ink">Community vote</p>
          <h2 id="community-title" className="mt-2 text-24 font-semibold">
            {community.tally ? (voted.length ? "The community's favourites" : "No community favourite this time") : "Hidden until voting closes"}
          </h2>
          <VoteRuleChanges changes={community.ruleChanges} className="mt-4" />
          <VoteCountChanges changes={community.countChanges} className="mt-4" />
          {community.tally && !voted.length ? (
            <p className="mt-3 text-17 text-ink-2">
              Voting closed{community.closesAt ? ` on ${formatUtc(community.closesAt, { weekday: true })}` : ""} with no votes counted, so no project has a
              community place.
            </p>
          ) : community.tally ? (
            <>
              {linkVotes ? (
                <p className="mt-3 text-15 text-ink-2">
                  Ballots from the open link, which anyone could use, are counted apart and shown on the right:{" "}
                  {community.countLink ? "the organizers chose to include them in the count." : "they change no place."}
                </p>
              ) : null}
              <ol className="mt-4 divide-y divide-rule border-y border-rule">
                {voted.map((t) => (
                  <li key={t.projectId} className={`tile grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 py-2.5 sm:grid-cols-[48px_48px_minmax(0,1fr)_minmax(120px,220px)_auto] ${t.place === 1 ? "lit" : ""}`}>
                    <span className={`font-display tnum ${t.place === 1 ? "text-24 text-accent-ink" : "text-20"}`}>{t.place ?? "–"}</span>
                    <span className="max-sm:hidden">
                      <Face id={t.projectId} cols={32} rows={18} className="block h-[27px] w-12" />
                    </span>
                    <span className="min-w-0 truncate">
                      <Link href={`/events/${event.slug}/projects/${t.projectId}`} className="font-semibold hover:underline">
                        {t.title}
                      </Link>{" "}
                      <span className="text-14 text-ink-2">· {t.teamName}</span>
                    </span>
                    <span className="col-span-3 col-start-1 row-start-2 block h-2 bg-sunken sm:col-span-1 sm:col-start-4 sm:row-start-1" aria-hidden="true">
                      <span
                        className={`grow-bar block h-full ${t.place === 1 ? "bg-accent" : "bg-face-dot"}`}
                        style={{ width: `${topVotes ? (t.votes / topVotes) * 100 : 0}%` }}
                      />
                    </span>
                    <span className="col-start-3 row-start-1 flex items-baseline justify-end gap-3 sm:col-start-5">
                      <span className="text-right text-15 font-semibold tnum sm:w-[4.5rem]">
                        {t.votes} {t.votes === 1 ? "vote" : "votes"}
                      </span>
                      {linkVotes ? (
                        <span className="w-24 text-right font-mono text-12 text-ink-2 tnum sm:w-28">
                          {t.openLink > 0 ? `${community.countLink ? "incl. " : "+"}${t.openLink} open link` : null}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
              {unvoted.length ? (
                // the projects nobody picked, named in one fold rather than a row of zeros each
                <details className="group mt-3 text-14 text-ink-2">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-2 py-1 [&::-webkit-details-marker]:hidden">
                    {plural(unvoted.length, "more project")} got no votes
                    <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
                  </summary>
                  <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {unvoted.map((t) => (
                      <li key={t.projectId}>
                        <Link href={`/events/${event.slug}/projects/${t.projectId}`} className="hover:underline">
                          {t.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : (
            <>
              <p className="mt-3 text-17 text-ink-2">
                Voting {community.state === "upcoming" ? "has not opened yet" : "is open"}; only the organizers see the count until it closes
                {community.closesAt ? ` on ${formatUtc(community.closesAt, { weekday: true })}` : ""}.
              </p>
              {community.state === "open" ? (
                <p className="mt-4">
                  <Link href={`/events/${event.slug}/vote`} className="text-15 font-semibold text-ink underline underline-offset-4 hover:text-accent-ink">
                    Pick your favourites on the ballot
                  </Link>
                </p>
              ) : null}
            </>
          )}
        </section>
      )}
    </PublicShell>
  );
}
