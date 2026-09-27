import Link from "next/link";
import { ModeToggle } from "@/components/mode-toggle";
import { PageMark } from "@/components/page-mark";

export type WorkTab = { href: string; label: string; active?: boolean };

/**
 * The work side's frame (judges, organizers): quiet surfaces, navy ink, the event
 * marked by one pink square. Pages pass their tabs and a slot for the top bar's
 * right-hand tools. The page's mark closes the bar on the right, in whatever room the
 * bar leaves (none, no mark); on a phone, where the bar wraps, it closes the brand row.
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
}) {
  // on the judge console the mark is the judge's own
  const markExtra = role === "Judge" ? person : undefined;
  return (
    <div className="work min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="relative border-b border-rule bg-surface">
        {/* on a phone the bar wraps, and the mark sits in the brand row's right-hand corner */}
        <PageMark anchor="right" cols={12} rows={11} extra={markExtra} className="absolute top-0 right-4 sm:hidden" />
        {/* On a phone the header wraps: the brand on the first row (beside the page's mark), the
            controls on the next, the tabs on a scrolling row of their own, so Sign out and the
            mode toggle never sit off-screen or under the mark. */}
        <div className="flex flex-wrap items-stretch gap-x-6 px-4 sm:h-12 sm:flex-nowrap sm:overflow-x-auto lg:px-8">
          <Link href={eventHref} className="flex shrink-0 items-center gap-3 self-center py-3 max-sm:basis-full max-sm:pr-16 sm:py-0">
            <span className="size-3 shrink-0 bg-accent" aria-hidden />
            <span title={eventName} className="max-w-[20rem] min-w-0 truncate text-15 font-semibold sm:max-w-[28rem]">
              {eventName}
            </span>
            {crumb ? (
              <span className="text-15 whitespace-nowrap text-ink-3 max-sm:hidden">
                <span aria-hidden>/ </span>
                {crumb}
              </span>
            ) : null}
          </Link>
          {tabs.length ? (
            <nav aria-label="Sections" className="flex items-stretch gap-6 max-sm:order-last max-sm:-mx-4 max-sm:h-11 max-sm:w-[calc(100%+2rem)] max-sm:overflow-x-auto max-sm:border-t max-sm:border-rule max-sm:px-4">
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
            {/* on a phone the name and role give way, so the mode toggle and Sign out stay on screen */}
            <span className="text-14 font-medium whitespace-nowrap max-sm:hidden">{person}</span>
            <span className="text-14 whitespace-nowrap text-ink-3 max-sm:hidden">{role}</span>
            <ModeToggle />
            <form action="/api/auth/sign-out" method="post">
              <button className="h-8 rounded-sm px-2 text-13 text-ink-2 hover:bg-raised hover:text-ink">Sign out</button>
            </form>
          </div>
          {/* the page's mark closes the bar on the right, only in room the bar does not use */}
          <div className="@container relative hidden max-w-[80px] min-w-0 flex-1 overflow-hidden sm:block" aria-hidden="true">
            <PageMark anchor="right" cols={20} rows={12} extra={markExtra} className="absolute top-0 right-0 hidden @min-[80px]:block" />
            <PageMark anchor="right" cols={10} rows={12} extra={markExtra} className="absolute top-0 right-0 @min-[80px]:hidden" />
          </div>
        </div>
      </header>
      <main id="main" className={flush ? "" : "mx-auto max-w-[1440px] px-4 py-8 lg:px-8"}>
        {children}
      </main>
    </div>
  );
}

export function organizerTabs(slug: string, active: string): WorkTab[] {
  return [
    { href: `/organize/${slug}`, label: "Overview" },
    { href: `/organize/${slug}/submissions`, label: "Submissions" },
    { href: `/organize/${slug}/judges`, label: "Judges" },
    { href: `/organize/${slug}/voting`, label: "Voting" },
    { href: `/organize/${slug}/results`, label: "Results" },
    { href: `/organize/${slug}/audit`, label: "Audit log" },
    { href: `/organize/${slug}/integrations`, label: "Integrations" },
    { href: `/organize/${slug}/settings`, label: "Settings" },
  ].map((t) => ({ ...t, active: t.label === active }));
}
