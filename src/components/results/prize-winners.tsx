import Link from "next/link";
import { Face } from "@/components/face";
import type { PrizeStanding } from "@/server/dal";

/**
 * The published prizes, each with its winners (a joint award names them all) and the organizers' note, in the
 * results page's language: a label-mono heading, then one column per prize under an accent rule, like the first
 * places. Rendered only when the results are published and at least one prize was awarded.
 */
export function PrizeWinners({ eventSlug, prizes }: { eventSlug: string; prizes: PrizeStanding[] }) {
  if (!prizes.some((p) => p.winners.length)) return null;
  return (
    <section aria-labelledby="prizes-title" className="mt-16 border-t border-rule pt-6">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <h2 id="prizes-title" className="label-mono text-ink">
          Prizes
        </h2>
        <p className="text-13 text-ink-3">Given by the organizers on the final places. Each winner opens its project.</p>
      </div>
      <ol className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {prizes.map((p) => (
          <li key={p.prizeId} className={`border-t-2 pt-2 wrap-anywhere ${p.winners.length ? "border-accent" : "border-rule"}`}>
            <h3 className="font-display text-20 leading-tight">{p.name}</h3>
            {p.description ? <p className="mt-1 text-13 text-ink-2">{p.description}</p> : null}
            {p.winners.length ? (
              <>
                {p.winners.length > 1 ? <p className="label-mono mt-3 text-ink-3">Joint winners · {p.winners.length}</p> : null}
                <ul className="mt-3 flex flex-col gap-3">
                  {p.winners.map((w) => (
                    <li key={w.projectId}>
                      <Link href={`/events/${eventSlug}/projects/${w.projectId}`} className="group grid grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
                        <span className="block overflow-hidden rounded-xs border border-rule">
                          <Face id={w.projectId} cols={32} rows={18} />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-15 font-semibold group-hover:underline">{w.title}</span>
                          <span className="block text-13 text-ink-2">
                            {w.teamName}
                            {w.trackName ? ` · ${w.trackName}` : ""}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {p.note ? <p className="mt-3 text-14 text-ink-2">&ldquo;{p.note}&rdquo;</p> : null}
              </>
            ) : (
              <p className="mt-3 text-14 text-ink-3">Not awarded.</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
