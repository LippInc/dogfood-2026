import Link from "next/link";
import { HelpSlot } from "@/components/help/help-slot";
import { ModeToggle } from "@/components/mode-toggle";
import { AccountMenu } from "@/components/shell/account-menu";
import { PageBand, PageMark } from "@/components/page-mark";

export type WorkTab = { href: string; label: string; active?: boolean };

/**
 * The work side's frame (judges, organizers): quiet surfaces, navy ink, the event
 * marked by one pink square. Pages pass their tabs and a slot for the top bar's
 * right-hand tools. The page's mark closes the bar on the right, in whatever room the
 * bar leaves (none, no mark); on a phone, where the bar wraps, it closes the brand row.
 * Below the page the mark runs out as a band along the foot, as on the public pages, except
 * on the judge console, whose phone layout keeps its answer buttons at the bottom of the screen.
 * Help sits beside the mode toggle; on the judge console its ? key stays the console's (the list of keys).
 */
export function WorkShell({
  eventName,
  eventHref,
  crumb,
  tabs = [],
  tools,
  person,
  role,
  children,
  flush = false,
  band = role !== "Judge",
  allEventsHref,
}: {
  eventName: string;
  eventHref: string;
  crumb?: string;
  tabs?: WorkTab[];
  tools?: React.ReactNode;
  person: string;
  role: string;
  children: React.ReactNode;
  flush?: boolean;
  band?: boolean;
  /** where "All events" goes; organizer pages of one event get /organize without asking */
  allEventsHref?: string;
}) {
  // on the judge console the mark is the judge's own
  const markExtra = role === "Judge" ? person : undefined;
  // the event in view, for Help's links
  const slug = slugFromHref(eventHref);
  const allEvents = allEventsLink(eventHref, allEventsHref);
  return (
    <div className={band ? "work flex min-h-dvh flex-col" : "work min-h-dvh"}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:border focus:border-ink focus:bg-surface focus:px-4 focus:py-2 focus:text-14 focus:font-medium focus:shadow-lg"
      >
        Skip to content
      </a>
      <header className="relative border-b border-rule bg-surface">
        {/* on a phone the bar wraps, and the mark sits in the brand row's right-hand corner */}
        <PageMark anchor="right" cols={12} rows={11} extra={markExtra} className="absolute top-0 right-4 sm:hidden" />
        {/* On a phone the header wraps: the brand on the first row (beside the page's mark), the
            controls on the next, the tabs on a scrolling row of their own, so the account menu and the
            mode toggle never sit off-screen or under the mark. */}
        <div className="flex flex-wrap items-stretch gap-x-4 px-4 sm:h-12 sm:flex-nowrap sm:overflow-x-auto lg:px-8 2xl:gap-x-6">
          <div className="flex min-w-0 shrink-0 items-center gap-3 self-center py-3 max-sm:basis-full max-sm:pr-16 sm:shrink sm:py-0">
          {/* the way out of an event to the list of them, before the event's name (an organizer found no other) */}
          {allEvents ? (
            <>
              <Link
                href={allEvents}
                className="shrink-0 text-14 whitespace-nowrap text-ink-2 underline decoration-transparent underline-offset-4 hover:text-ink hover:decoration-ink"
              >
                All events
              </Link>
              <span className="shrink-0 text-15 text-ink-3" aria-hidden>
                /
              </span>
            </>
          ) : null}
          <Link href={eventHref} className="flex min-w-0 items-center gap-3">
            <span className="size-3 shrink-0 bg-accent" aria-hidden />
            <span title={eventName} className="max-w-[20rem] min-w-0 truncate text-15 font-semibold sm:max-w-[28rem]">
              {eventName}
            </span>
            {/* the crumb stays on a phone too (the console's only cue that this is judging): the name truncates first,
                which needs the link's min-w-0 (a long name pushed the page wider than a 390 px phone before) */}
            {crumb ? (
              <span className="shrink-0 text-15 whitespace-nowrap text-ink-3">
                <span aria-hidden>/ </span>
                {crumb}
              </span>
            ) : null}
          </Link>
          </div>
          {tabs.length ? (
            <nav aria-label="Sections" className="flex items-stretch gap-5 max-sm:order-last max-sm:-mx-4 max-sm:h-11 max-sm:w-[calc(100%+2rem)] max-sm:overflow-x-auto max-sm:border-t max-sm:border-rule max-sm:px-4 2xl:gap-6">
              {tabs.map((t) => (
                <Link
                  key={t.href}
                  href={t.href}
                  aria-current={t.active ? "page" : undefined}
                  className="flex items-center border-b-2 border-transparent pt-0.5 text-14 whitespace-nowrap text-ink-2 hover:text-ink aria-[current=page]:border-ink aria-[current=page]:font-medium aria-[current=page]:text-ink"
                >
                  {t.label}
                </Link>
              ))}
            </nav>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-3 py-2 sm:shrink-0 sm:flex-nowrap sm:py-0">
            {tools}
            <HelpSlot event={slug ? { slug, name: eventName } : null} variant="work" questionKey={role !== "Judge"} />
            <ModeToggle />
            {/* the name, the role and Sign out live in the account menu, so the bar fits from 1280 px up on every page */}
            <AccountMenu person={person} role={role} />
          </div>
          {/* the page's mark closes the bar on the right, only in room the bar does not use */}
          <div className="@container relative hidden max-w-[80px] min-w-0 flex-1 overflow-hidden sm:block" aria-hidden="true">
            <PageMark anchor="right" cols={20} rows={12} extra={markExtra} className="absolute top-0 right-0 hidden @min-[80px]:block" />
            <PageMark anchor="right" cols={10} rows={12} extra={markExtra} className="absolute top-0 right-0 @min-[80px]:hidden" />
          </div>
        </div>
      </header>
      <main id="main" className={`${flush ? "" : "mx-auto w-full max-w-[1440px] px-4 py-8 lg:px-8"} ${band ? "flex-1" : ""}`}>
        {children}
      </main>
      {band ? (
        <div className="flex h-24 justify-center overflow-hidden print:hidden" aria-hidden="true">
          <PageBand anchor="bottom" cols={480} rows={24} />
        </div>
      ) : null}
    </div>
  );
}

/** The event an event page's link names: /organize/<slug>, /judge/<slug> or /events/<slug>; null for the portal's own pages. */
export function slugFromHref(href: string): string | null {
  const m = /^\/(?:organize|judge|events)\/([^/?#]+)/.exec(href);
  return m && m[1] !== "new" && m[1] !== "accounts" && m[1] !== "log" ? decodeURIComponent(m[1]) : null;
}

/**
 * Where the top bar's "All events" leads: the page's own choice when it makes one (the judge console, for a judge
 * with more than one event), else /organize from any page of one event on the organizer side; none on the portal's
 * own pages (/organize itself, New event, Accounts, the portal log), whose name already links to the list.
 */
export function allEventsLink(eventHref: string, override?: string): string | null {
  if (override) return override;
  return eventHref.startsWith("/organize/") && slugFromHref(eventHref) ? "/organize" : null;
}

export function organizerTabs(slug: string, active: string): WorkTab[] {
  return [
    { href: `/organize/${slug}`, label: "Overview" },
    { href: `/organize/${slug}/submissions`, label: "Submissions" },
    { href: `/organize/${slug}/judges`, label: "Judges" },
    { href: `/organize/${slug}/voting`, label: "Voting" },
    { href: `/organize/${slug}/finals`, label: "Finals" },
    { href: `/organize/${slug}/results`, label: "Results" },
    { href: `/organize/${slug}/audit`, label: "Audit log" },
    { href: `/organize/${slug}/integrations`, label: "Integrations" },
    { href: `/organize/${slug}/settings`, label: "Settings" },
  ].map((t) => ({ ...t, active: t.label === active }));
}
