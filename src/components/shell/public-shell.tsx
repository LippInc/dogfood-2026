import Link from "next/link";
import { DemoTour } from "@/components/demo-tour";
import { HelpSlot } from "@/components/help/help-slot";
import { ModeToggle } from "@/components/mode-toggle";
import { PageBand, PageMark } from "@/components/page-mark";
import { PhoneMenu } from "@/components/shell/phone-menu";
import { eventPhase, idLabel, type EventTimes } from "@/lib/format";
import type { NavLink } from "@/server/dal";

type ShellEvent = EventTimes & { id: string; slug: string; name: string; votingOpenAt?: string | null };
type Section = "projects" | "vote" | "results" | "about" | "none";

const SECTIONS: { key: Section; label: string; path: string }[] = [
  { key: "projects", label: "Projects", path: "" },
  { key: "vote", label: "Vote", path: "/vote" },
  { key: "results", label: "Results", path: "/results" },
  { key: "about", label: "About", path: "/about" },
];

/** The public side's frame: event masthead, section nav, account, mode, status strip. */
export function PublicShell({
  event,
  active,
  signedInAs,
  links,
  children,
}: {
  event: ShellEvent;
  active: Section;
  signedInAs: string | null;
  links: NavLink[];
  children: React.ReactNode;
}) {
  const phase = eventPhase(event);
  const base = `/events/${event.slug}`;
  // The way in for someone with no role in this event yet, while teams can form:
  // the team page (start or join a team), through sign-up when signed out.
  const myProject = `${base}/my-project`;
  const inEvent = links.some((l) => l.href === myProject || l.href.endsWith(`/${event.slug}`));
  const takePart =
    (phase.key === "open" || phase.key === "upcoming") && !inEvent ? (signedInAs ? myProject : `/sign-up?next=${encodeURIComponent(myProject)}`) : null;
  return (
    <div className="public flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:border focus:border-ink focus:bg-surface focus:px-4 focus:py-2 focus:text-14 focus:font-medium focus:shadow-lg"
      >
        Skip to content
      </a>
      <header className="border-b border-rule print:hidden">
        <div className="mx-auto flex h-16 max-w-[1440px] items-stretch gap-8 px-4 sm:px-8 xl:px-16">
          <Link href={base} className="flex items-center gap-4 self-center">
            {idLabel(event.id) ? <span className="label-mono hidden whitespace-nowrap text-ink-3 sm:inline md:hidden lg:inline">[ {idLabel(event.id)} ]</span> : null}
            <span title={event.name} className="line-clamp-2 font-display text-20 leading-none tracking-[0.01em] uppercase wrap-anywhere">
              {event.name}
            </span>
          </Link>
          <nav aria-label="Event" className="hidden items-stretch gap-7 md:flex">
            {SECTIONS.filter((s) => s.key !== "vote" || event.votingOpenAt).map((s) => (
              <Link
                key={s.key}
                href={base + s.path}
                aria-current={active === s.key ? "page" : undefined}
                className="flex items-center border-b-2 border-transparent pt-0.5 text-15 text-ink-2 hover:text-ink aria-[current=page]:border-accent aria-[current=page]:text-ink"
              >
                {s.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <HelpSlot event={{ slug: event.slug, name: event.name }} variant="public" />
            <ModeToggle />
            {takePart ? (
              <Link href={takePart} className="hidden h-10 items-center rounded-sm bg-primary px-4 text-15 font-medium text-on-primary hover:opacity-90 md:inline-flex">
                Take part
              </Link>
            ) : null}
            {signedInAs ? (
              <div className="hidden items-center gap-3 md:flex">
                {links.map((l) => (
                  <Link key={l.href} href={l.href} className="text-14 text-ink-2 underline decoration-rule hover:text-ink">
                    {l.label}
                  </Link>
                ))}
                <span title={signedInAs} className="max-h-10 max-w-40 overflow-y-clip text-14 font-medium wrap-break-word lg:max-w-56">
                  {signedInAs}
                </span>
                <form action="/api/auth/sign-out" method="post">
                  <button className="h-10 rounded-sm border border-edge px-4 text-14 hover:bg-surface">Sign out</button>
                </form>
              </div>
            ) : (
              <Link
                href={`/sign-in?next=${encodeURIComponent(base)}`}
                className="hidden h-10 items-center rounded-sm border border-edge px-4 text-15 hover:bg-surface md:inline-flex"
              >
                Sign in
              </Link>
            )}
            <PhoneMenu>
              {SECTIONS.filter((s) => s.key !== "vote" || event.votingOpenAt).map((s) => (
                <Link
                  key={s.key}
                  href={base + s.path}
                  aria-current={active === s.key ? "page" : undefined}
                  className="flex h-11 items-center rounded-sm px-3 text-15 hover:bg-raised aria-[current=page]:font-semibold"
                >
                  {s.label}
                </Link>
              ))}
              <div className="my-2 border-t border-rule" />
              {takePart ? (
                <Link href={takePart} className="flex h-11 items-center rounded-sm px-3 text-15 font-semibold hover:bg-raised">
                  Take part
                </Link>
              ) : null}
              {signedInAs ? (
                <>
                  {links.map((l) => (
                    <Link key={l.href} href={l.href} className="flex h-11 items-center rounded-sm px-3 text-15 hover:bg-raised">
                      {l.label}
                    </Link>
                  ))}
                  <form action="/api/auth/sign-out" method="post">
                    <button className="flex h-11 w-full items-center rounded-sm px-3 text-left text-15 hover:bg-raised">
                      <span className="truncate">Sign out ({signedInAs})</span>
                    </button>
                  </form>
                </>
              ) : (
                <Link href={`/sign-in?next=${encodeURIComponent(base)}`} className="flex h-11 items-center rounded-sm px-3 text-15 hover:bg-raised">
                  Sign in
                </Link>
              )}
            </PhoneMenu>
          </div>
        </div>
      </header>
      {/* The status strip, and the page's own mark at its right end: a band of pixels that
          fades out towards the status (on a phone, a short one beside the first line). */}
      <div className="border-b border-rule bg-sunken print:hidden">
        <div className="relative mx-auto flex max-w-[1440px] items-stretch gap-8 px-4 sm:px-8 xl:px-16">
          <p className="flex min-w-0 flex-col gap-1 py-2.5 text-ink-2 sm:flex-row sm:items-center sm:gap-0">
            {phase.parts.map((part, i) => (
              <span key={part} className={`label-mono flex items-center ${i === 0 ? "max-sm:pr-28" : ""}`}>
                {i === 0 ? <span className="mr-3 inline-block size-2 shrink-0 bg-accent" aria-hidden /> : null}
                {i > 0 ? <span className="mx-3 hidden text-ink-3 sm:inline" aria-hidden>/</span> : null}
                {part}
              </span>
            ))}
          </p>
          {/* the widest whole mark that fits beside the status (a container query, no script) */}
          <div className="@container relative ml-auto hidden max-w-[320px] min-w-0 flex-1 overflow-hidden sm:block" aria-hidden="true">
            <PageMark anchor="right" cols={80} rows={9} className="absolute top-0 right-0 hidden @min-[320px]:block" />
            <PageMark anchor="right" cols={40} rows={9} className="absolute top-0 right-0 hidden @min-[160px]:block @min-[320px]:hidden" />
            <PageMark anchor="right" cols={20} rows={9} className="absolute top-0 right-0 @min-[160px]:hidden" />
          </div>
          <PageMark anchor="right" cols={24} rows={4} className="absolute top-2.5 right-4 sm:hidden" />
        </div>
      </div>
      <DemoTour eventSlug={event.slug} />
      <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-4 pb-24 sm:px-8 xl:px-16 print:p-0">
        {children}
      </main>
      {/* The page's mark again, drawn out in full: a band of pixels along the foot of the
          page, dense at the bottom edge and fading up, like the band on the demo video's
          drawing sheets. It closes every public page; narrower screens see its middle. */}
      <div className="flex h-24 justify-center overflow-hidden print:hidden" aria-hidden="true">
        <PageBand anchor="bottom" cols={480} rows={24} />
      </div>
    </div>
  );
}
