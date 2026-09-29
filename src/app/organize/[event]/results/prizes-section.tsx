import Link from "next/link";
import { exportHref } from "@/lib/export-href";
import { formatUtc } from "@/lib/format";
import { ordinal } from "@/lib/places";
import type { PrizeStanding } from "@/server/dal";
import { PrizeAwardForm, type PrizeCandidate } from "./prizes-step";

/**
 * The Prizes step: each of the event's prizes, who wins it, and the places beside them to help. Before publishing
 * each prize is its own form (one audited save each); once published the awards are final and read as a list.
 * An event with no prizes gets no section at all.
 */
export function PrizesSection({
  eventId,
  eventSlug,
  published,
  prizes,
  candidates,
}: {
  eventId: string;
  eventSlug: string;
  published: boolean;
  prizes: PrizeStanding[];
  candidates: PrizeCandidate[];
}) {
  if (!prizes.length) return null;
  const awarded = prizes.filter((p) => p.winners.length).length;
  const byId = new Map(candidates.map((c) => [c.projectId, c]));
  return (
    <section aria-labelledby="prizes-title" className="flex scroll-mt-6 flex-col gap-4 border-t border-rule pt-8">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="prizes-title" className="text-20 font-semibold">
            Prizes
          </h2>
          <a href={exportHref(eventId, "awards.csv")} className="text-13 underline underline-offset-4">
            awards.csv
          </a>
        </div>
        <p className="mt-1 max-w-[720px] text-14 text-ink-2">
          {published
            ? `${awarded} of ${prizes.length} awarded. The awards were final with the results: the public results, each winner's project page and their certificates show them.`
            : `${awarded} of ${prizes.length} awarded. Give each prize to a project, or to several for a joint award, with the ranking's places beside them to help. A prize left unawarded stays unawarded when you publish; publishing makes the awards final. Each save is one entry in the audit log.`}{" "}
          <Link href={`/organize/${eventSlug}/settings`} className="underline decoration-edge underline-offset-4 hover:decoration-ink">
            {published ? "The prizes" : "Name and describe the prizes in Settings"}
          </Link>
          .
        </p>
      </div>
      <ol className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        {prizes.map((p, i) => (
          <li key={p.prizeId} className="flex flex-col gap-3 rounded-sm border border-rule bg-surface p-5 wrap-anywhere">
            <div>
              <p className="label-mono text-ink-2 tnum">Prize {String(i + 1).padStart(2, "0")}</p>
              <h3 id={`prize-${p.prizeId}-name`} className="mt-1 text-17 font-semibold">
                {p.name}
              </h3>
              {p.description ? <p className="mt-1 text-14 text-ink-2">{p.description}</p> : null}
            </div>
            {published ? (
              p.winners.length ? (
                <div className="flex flex-col gap-1.5 border-t border-rule pt-3">
                  <ul className="flex flex-col gap-1 text-14">
                    {p.winners.map((w) => {
                      const c = byId.get(w.projectId);
                      return (
                        <li key={w.projectId}>
                          <span className="font-medium">{w.title}</span>
                          <span className="text-13 text-ink-2">
                            {" "}
                            · {w.teamName}
                            {c?.place ? ` · ${c.joint ? "joint " : ""}${ordinal(c.place)} in ${c.trackName}` : ""}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {p.note ? <p className="text-13 text-ink-2">&ldquo;{p.note}&rdquo;</p> : null}
                  {p.at ? <p className="font-mono text-12 text-ink-3 tnum">awarded {formatUtc(p.at)}</p> : null}
                </div>
              ) : (
                <p className="border-t border-rule pt-3 text-14 text-ink-2">Not awarded.</p>
              )
            ) : (
              <PrizeAwardForm eventSlug={eventSlug} prize={p} candidates={candidates} />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
