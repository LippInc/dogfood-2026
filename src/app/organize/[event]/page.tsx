import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { Face } from "@/components/face";
import { LeniencyStrip } from "@/components/figures/leniency-strip";
import { LiveRefresh } from "@/components/live-refresh";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { formatUtc } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import {
  currentActor,
  getOverview,
  type AuditLine,
  type Stage,
} from "@/server/dal";
import { CopyButton } from "./judges/forms";
import { Decisions, PublishPanel } from "./decisions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Overview" };

const EXPORTS = [
  "scores.csv",
  "projects.csv",
  "normalized.csv",
  "audit.csv",
  "event.json",
];

function Pipeline({ stages }: { stages: Stage[] }) {
  const reached = stages.filter((s) => s.done).length;
  return (
    <nav
      aria-label="Event pipeline"
      className="border-b border-rule bg-surface"
    >
      <ol className="mx-auto grid max-w-[1440px] grid-cols-2 gap-y-4 px-4 py-4 sm:grid-cols-5 lg:grid-cols-10 lg:px-8">
        {stages.map((s, i) => (
          <li
            key={s.no}
            className="relative pt-4"
            aria-current={s.current ? "step" : undefined}
          >
            <span
              aria-hidden
              className={`absolute top-0 right-0 left-0 h-[3px] ${i < reached ? "bg-ink" : "bg-rule"} ${i === 0 ? "rounded-l-full" : ""} ${i === stages.length - 1 ? "rounded-r-full" : ""}`}
            />
            {s.open ? (
              <span
                aria-hidden
                className="absolute -top-[3px] left-0 size-[9px] bg-flag-bar"
              />
            ) : null}
            <p className="font-mono text-12 text-ink-3">{s.no}</p>
            <p
              className={`text-14 ${s.current ? "font-semibold" : "text-ink-2"}`}
            >
              {s.name}
            </p>
            <p
              className={`text-12 ${s.open ? "font-medium text-flag" : "text-ink-2"}`}
            >
              {s.state}
            </p>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function AuditSentence({ line }: { line: AuditLine }) {
  return (
    <>
      {line.parts.map((p, i) =>
        p.mono ? (
          <span key={i} className="font-mono text-12 text-ink-2">
            {p.text}
          </span>
        ) : p.strong ? (
          <strong key={i} className="font-semibold">
            {p.text}
          </strong>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export default async function OverviewPage({
  params,
}: PageProps<"/organize/[event]">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const o = guardPage(() => getOverview(actor, key));
  const { event, judges, normalization: nz } = o;
  const origin = process.env.PUBLIC_URL ?? "http://localhost:8080";
  const faceIds = new Set(
    o.decisions.flatMap((d) =>
      d.kind === "flat_judge"
        ? d.evidence.map((e) => e.projectId)
        : d.kind === "duplicate"
          ? d.copies.map((c) => c.id)
          : [d.projectId],
    ),
  );
  const faces = Object.fromEntries(
    [...faceIds].map((id) => [
      id,
      <Face
        key={id}
        id={id}
        cols={32}
        rows={18}
        className="block h-[18px] w-8"
      />,
    ]),
  );
  const reminders = judges.unfinished
    .map(
      (j) =>
        `Hi ${j.name}, ${j.assigned - j.done} of your ${j.assigned} reviews for ${event.name} are still open. Your console: ${origin}/judge/${event.slug}`,
    )
    .join("\n\n");

  const snippet = `<script src="${origin}/embed.js" data-event="${event.slug}" async></script>`;

  return (
    <WorkShell
      eventName={event.name}
      eventHref={`/organize/${event.slug}`}
      tabs={organizerTabs(event.slug, "Overview")}
      tools={
        <>
          <LiveRefresh />
          <a
            href={`/api/events/${event.id}/export/scores.csv`}
            className="inline-flex h-8 items-center rounded-sm border border-edge px-3 text-13 font-medium hover:bg-raised"
          >
            Export CSV
          </a>
        </>
      }
      person={actor.name}
      role="Organizer"
      flush
    >
      <Pipeline stages={o.pipeline} />
      <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-6 lg:px-8">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-3">
          <Decisions
            eventSlug={event.slug}
            decisions={o.decisions}
            faces={faces}
          />
          <PublishPanel
            eventSlug={event.slug}
            open={o.open}
            total={o.decisions.length}
            publishedAt={event.resultsPublishedAt}
          />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-3">
          <section
            aria-labelledby="judges-card"
            className="flex flex-col gap-3 rounded-sm border border-rule bg-surface p-5"
          >
            <div className="flex items-baseline justify-between">
              <h2 id="judges-card" className="text-15 font-semibold">
                Judges
              </h2>
              <Link
                href={`/organize/${event.slug}/judges`}
                className="text-13 underline underline-offset-4"
              >
                All {judges.total}
              </Link>
            </div>
            <p className="flex items-baseline gap-2">
              <span className="text-38 leading-none font-semibold tnum">
                {judges.finished}
              </span>
              <span className="text-13 text-ink-2 tnum">
                of {judges.total} finished · {judges.reviewsDone} of{" "}
                {judges.reviewsAssigned} reviews in
              </span>
            </p>
            {judges.segments.length ? (
              <div className="flex gap-[3px]" aria-hidden>
                {judges.segments.map((s, i) => (
                  <span
                    key={i}
                    className={`h-3 flex-1 border ${s === "done" ? "border-ink bg-ink" : s === "open" ? "border-edge bg-transparent" : "border-rule bg-sunken"}`}
                  />
                ))}
              </div>
            ) : null}
            {judges.unfinished.length ? (
              <>
                <ul className="divide-y divide-rule border-y border-rule">
                  {judges.unfinished.slice(0, 3).map((j) => (
                    <li
                      key={j.id}
                      className="flex items-baseline justify-between gap-3 py-2 text-14"
                    >
                      <span className="font-medium">{j.name}</span>
                      <span className="truncate text-13 text-ink-2">
                        {j.tracks} · {j.done} of {j.assigned}
                      </span>
                    </li>
                  ))}
                </ul>
                <div>
                  <CopyButton
                    text={reminders}
                    label={`Copy ${judges.unfinished.length} ${judges.unfinished.length === 1 ? "reminder" : "reminders"}`}
                  />
                </div>
              </>
            ) : (
              <p className="text-14 text-ink-2">
                {judges.reviewsAssigned
                  ? "Every assigned review is in."
                  : "No reviews assigned yet."}
              </p>
            )}
          </section>

          <section
            aria-labelledby="norm-card"
            className="flex flex-col gap-3 rounded-sm border border-rule bg-surface p-5"
          >
            <div className="flex items-baseline justify-between">
              <h2 id="norm-card" className="text-15 font-semibold">
                Normalization
              </h2>
              <span className="text-13 text-ink-2">
                {event.resultsPublishedAt ? "published run" : "preview"}
              </span>
            </div>
            {nz.ranked ? (
              <>
                <p className="text-24 font-semibold">
                  {nz.k === null
                    ? "No judge leniency found"
                    : `Every judge within ±${nz.maxLeniency.toFixed(2)}`}
                </p>
                <LeniencyStrip
                  points={nz.points}
                  label={`Leniency of ${nz.points.length} judges: plain averages against what the data supports`}
                />
                <p className="text-13 leading-5 text-ink-2">
                  {nz.k === null
                    ? "The scores show no steady difference between lenient and harsh judges, so the engine corrects nothing and ranks by the plain mean."
                    : `With ${nz.minReviews} to ${nz.maxReviews} reviews per judge, the data can barely tell a lenient judge from a strong batch, so the engine keeps at most ${Math.round(nz.keptShare * 100)} % of any judge's tilt (k = ${nz.k.toFixed(1)}).`}
                  {nz.excludedNames.length
                    ? ` Left out: ${nz.excludedNames.join(", ")}.`
                    : ""}
                </p>
                <div>
                  <Link
                    href={`/organize/${event.slug}/results`}
                    className="inline-flex h-8 items-center rounded-sm border border-edge px-3 text-13 font-medium hover:bg-raised"
                  >
                    Show the working
                  </Link>
                </div>
              </>
            ) : (
              <p className="text-14 text-ink-2">
                Nothing to normalize until reviews are finished.
              </p>
            )}
          </section>

          <section
            aria-labelledby="audit-card"
            className="flex flex-col gap-3 rounded-sm border border-rule bg-surface p-5"
          >
            <div className="flex items-baseline justify-between">
              <h2 id="audit-card" className="text-15 font-semibold">
                Audit log
              </h2>
              <Link
                href={`/organize/${event.slug}/audit`}
                className="text-13 underline underline-offset-4"
              >
                Full log
              </Link>
            </div>
            {o.audit.length ? (
              <ol className="divide-y divide-rule border-t border-rule">
                {o.audit.map((line) => (
                  <li
                    key={line.id}
                    className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 py-2.5 text-14 leading-5"
                  >
                    <span className="font-mono text-12 text-ink-3">
                      {formatUtc(line.at)
                        .replace(/ \d{4},/, "")
                        .replace(" UTC", "")}
                    </span>
                    <span>
                      <AuditSentence line={line} />.
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-14 text-ink-2">
                Nothing logged for this event yet.
              </p>
            )}
            <div className="mt-auto flex flex-wrap gap-2 border-t border-rule pt-3">
              {EXPORTS.map((f) => (
                <a
                  key={f}
                  href={`/api/events/${event.id}/export/${f}`}
                  className="inline-flex h-7 items-center rounded-sm border border-edge px-2 font-mono text-12 hover:bg-raised"
                >
                  {f}
                </a>
              ))}
            </div>
          </section>
        </div>

        <section
          aria-labelledby="share-card"
          className="flex flex-col gap-3 rounded-sm border border-rule bg-surface p-5"
        >
          <div className="flex items-baseline justify-between">
            <h2 id="share-card" className="text-15 font-semibold">
              Put the gallery on your site
            </h2>
            <Link
              href={`/embed/${event.slug}`}
              className="text-13 underline underline-offset-4"
            >
              Preview
            </Link>
          </div>
          <p className="text-14 text-ink-2">
            Paste this where the gallery should appear; it grows to fit its
            projects. Add <code className="font-mono text-13">{'data-track="Track name"'}</code>{" "}
            to show one track.
          </p>
          <div className="flex flex-col items-start gap-2 sm:flex-row">
            <pre className="w-full min-w-0 flex-1 whitespace-pre-wrap break-all rounded-sm border border-rule bg-raised px-3 py-2 font-mono text-12">
              {snippet}
            </pre>
            <CopyButton text={snippet} label="Copy snippet" />
          </div>
        </section>
      </div>
    </WorkShell>
  );
}
