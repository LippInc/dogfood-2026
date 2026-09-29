import Link from "next/link";
import { formatUtc } from "@/lib/format";
import type { UpdateView } from "@/server/dal";

// The organizers' updates on the event's public pages. An update is plain text: React prints it as text, so a
// planted tag shows as its own characters and never runs; its line breaks are kept (whitespace-pre-line) and a web
// address in it reads as text, not a link. With no update nothing at all is drawn, so an event without updates
// renders exactly as before.

/** One update: when, its title, and its words (clamped to a few lines where the page only points to it). */
export function UpdateEntry({ u, clamp = false }: { u: UpdateView; clamp?: boolean }) {
  return (
    <article className="grid gap-x-6 gap-y-1 py-4 md:grid-cols-[200px_minmax(0,1fr)]">
      <p className="label-mono tnum text-ink-3 md:pt-[3px]">
        <time dateTime={u.at}>{formatUtc(u.at)}</time>
        {u.editedAt ? <span className="block normal-case tracking-normal">edited {formatUtc(u.editedAt)}</span> : null}
      </p>
      <div className="min-w-0">
        <h3 className="text-17 font-semibold wrap-anywhere">{u.title}</h3>
        <p className={`mt-1 max-w-[680px] font-serif text-15 leading-6 whitespace-pre-line text-ink-2 wrap-anywhere ${clamp ? "line-clamp-2" : ""}`}>{u.body}</p>
      </div>
    </article>
  );
}

/** The newest few updates with a way to every one of them; nothing when there is none. */
/** closed: a rule under the last update, for a page whose next part draws none of its own. */
export function LatestUpdates({
  slug,
  updates,
  total,
  clamp = false,
  closed = true,
  className = "",
}: {
  slug: string;
  updates: UpdateView[];
  total: number;
  clamp?: boolean;
  closed?: boolean;
  className?: string;
}) {
  if (!updates.length) return null;
  return (
    <section aria-labelledby="updates-title" className={`border-t border-rule pt-6 ${className}`}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-5">
        <h2 id="updates-title" className="label-mono text-ink">
          From the organizers
        </h2>
        <Link href={`/events/${slug}/updates`} className="text-13 text-ink-2 underline underline-offset-2 hover:text-ink">
          {total > updates.length ? `Every update (${total})` : total === 1 ? "The update on its own page" : `All ${total} updates on their own page`}
        </Link>
      </div>
      <div className={`mt-2 divide-y divide-rule ${closed ? "border-b border-rule" : ""}`}>
        {updates.map((u) => (
          <UpdateEntry key={u.id} u={u} clamp={clamp} />
        ))}
      </div>
    </section>
  );
}
