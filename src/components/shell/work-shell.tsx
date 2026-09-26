import Link from "next/link";
import { ModeToggle } from "@/components/mode-toggle";

export type WorkTab = { href: string; label: string; active?: boolean };

/**
 * The work side's frame (judges, organizers): quiet surfaces, navy ink, the event
 * marked by one pink square. Pages pass their tabs and a slot for the top bar's
 * right-hand tools.
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
  return (
    <div className="work min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-rule bg-surface">
        <div className="flex h-12 items-stretch gap-6 overflow-x-auto px-4 lg:px-8">
          <Link href={eventHref} className="flex shrink-0 items-center gap-3 self-center">
            <span className="size-3 bg-accent" aria-hidden />
            <span className="text-15 font-semibold whitespace-nowrap">{eventName}</span>
            {crumb ? (
              <span className="text-15 whitespace-nowrap text-ink-3">
                <span aria-hidden>/ </span>
                {crumb}
              </span>
            ) : null}
          </Link>
          {tabs.length ? (
            <nav aria-label="Sections" className="flex items-stretch gap-6">
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
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {tools}
            <span className="text-14 font-medium whitespace-nowrap">{person}</span>
            <span className="text-14 whitespace-nowrap text-ink-3">{role}</span>
            <ModeToggle />
            <form action="/api/auth/sign-out" method="post">
              <button className="h-8 rounded-sm px-2 text-13 text-ink-2 hover:bg-raised hover:text-ink">Sign out</button>
            </form>
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
    { href: `/organize/${slug}/results`, label: "Results" },
    { href: `/organize/${slug}/audit`, label: "Audit log" },
    { href: `/organize/${slug}/settings`, label: "Settings" },
  ].map((t) => ({ ...t, active: t.label === active }));
}
