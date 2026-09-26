import Link from "next/link";
import { Menu } from "lucide-react";
import { ModeToggle } from "@/components/mode-toggle";
import { eventPhase, idLabel, type EventTimes } from "@/lib/format";
import type { NavLink } from "@/server/dal";

type ShellEvent = EventTimes & { id: string; slug: string; name: string };
type Section = "projects" | "results" | "about";

const SECTIONS: { key: Section; label: string; path: string }[] = [
  { key: "projects", label: "Projects", path: "" },
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
  return (
    <div className="public min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 max-w-[1440px] items-stretch gap-8 px-4 sm:px-8 xl:px-16">
          <Link href={base} className="flex items-center gap-4 self-center">
            <span className="label-mono hidden text-ink-3 sm:inline">[ {idLabel(event.id)} ]</span>
            <span className="font-display text-20 leading-none tracking-[0.01em] uppercase">{event.name}</span>
          </Link>
          <nav aria-label="Event" className="hidden items-stretch gap-7 md:flex">
            {SECTIONS.map((s) => (
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
            <ModeToggle />
            {signedInAs ? (
              <div className="hidden items-center gap-3 md:flex">
                {links.map((l) => (
                  <Link key={l.href} href={l.href} className="text-14 text-ink-2 underline decoration-rule hover:text-ink">
                    {l.label}
                  </Link>
                ))}
                <span className="text-14 font-medium">{signedInAs}</span>
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
            <details className="relative md:hidden">
              <summary className="flex size-11 cursor-pointer list-none items-center justify-center rounded-sm [&::-webkit-details-marker]:hidden">
                <Menu className="size-5" aria-hidden />
                <span className="sr-only">Menu</span>
              </summary>
              <div className="absolute right-0 z-40 mt-1 w-64 rounded-sm border border-rule bg-surface p-2 shadow-overlay">
                {SECTIONS.map((s) => (
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
                {signedInAs ? (
                  <>
                    {links.map((l) => (
                      <Link key={l.href} href={l.href} className="flex h-11 items-center rounded-sm px-3 text-15 hover:bg-raised">
                        {l.label}
                      </Link>
                    ))}
                    <form action="/api/auth/sign-out" method="post">
                      <button className="flex h-11 w-full items-center rounded-sm px-3 text-left text-15 hover:bg-raised">
                        Sign out ({signedInAs})
                      </button>
                    </form>
                  </>
                ) : (
                  <Link href={`/sign-in?next=${encodeURIComponent(base)}`} className="flex h-11 items-center rounded-sm px-3 text-15 hover:bg-raised">
                    Sign in
                  </Link>
                )}
              </div>
            </details>
          </div>
        </div>
      </header>
      <div className="border-b border-rule bg-sunken">
        <p className="mx-auto flex max-w-[1440px] flex-col gap-1 px-4 py-2.5 text-ink-2 sm:flex-row sm:items-center sm:gap-0 sm:px-8 xl:px-16">
          {phase.parts.map((part, i) => (
            <span key={part} className="label-mono flex items-center">
              {i === 0 ? <span className="mr-3 inline-block size-2 bg-accent" aria-hidden /> : null}
              {i > 0 ? <span className="mx-3 hidden text-ink-3 sm:inline" aria-hidden>/</span> : null}
              {part}
            </span>
          ))}
        </p>
      </div>
      <main id="main" className="mx-auto max-w-[1440px] px-4 pb-24 sm:px-8 xl:px-16">
        {children}
      </main>
    </div>
  );
}
