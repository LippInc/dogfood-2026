import Link from "next/link";
import { ModeToggle } from "@/components/mode-toggle";

/**
 * The markup of PlainShell (plain-shell.tsx), which pages use. It stays free of
 * server-only code so the error boundary, a client component, can wear the same frame;
 * `mark` is the slot PlainShell fills with the page's mark, `band` the one for its band along the foot,
 * `help` the one for the Help button (HelpSlot from a server page, a plain HelpButton from the error boundary).
 */
export function PlainFrame({
  children,
  width = "max-w-[1040px]",
  account,
  mark,
  band,
  help,
}: {
  children: React.ReactNode;
  width?: string;
  account?: { name: string } | null;
  mark?: React.ReactNode;
  band?: React.ReactNode;
  help?: React.ReactNode;
}) {
  return (
    <div className="public flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:border focus:border-ink focus:bg-surface focus:px-4 focus:py-2 focus:text-14 focus:font-medium focus:shadow-lg"
      >
        Skip to content
      </a>
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-2 px-4 sm:gap-3 sm:px-8 xl:px-16">
          {/* one line from 375 px, beside Help, the mode toggle and Sign in or Sign out: the name steps down a size on a phone */}
          <Link href="/" className="font-display text-15 whitespace-nowrap uppercase min-[390px]:text-17 min-[480px]:text-20">
            Dogfood portal
          </Link>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {help}
            <ModeToggle />
          </div>
          {account === undefined ? null : account ? (
            <>
              <span title={account.name} className="hidden max-w-56 truncate text-14 font-medium sm:block">
                {account.name}
              </span>
              <form action="/api/auth/sign-out" method="post">
                <button className="h-10 rounded-sm border border-edge px-3 text-14 whitespace-nowrap hover:bg-surface sm:px-4">Sign out</button>
              </form>
            </>
          ) : (
            <Link href="/sign-in" className="inline-flex h-10 items-center rounded-sm border border-edge px-3 text-15 whitespace-nowrap hover:bg-surface sm:px-4">
              Sign in
            </Link>
          )}
        </div>
      </header>
      {mark ? (
        <div className="relative mx-auto w-full max-w-[1440px] print:hidden" aria-hidden="true">
          {mark}
        </div>
      ) : null}
      <main id="main" className={`mx-auto w-full flex-1 ${width} px-4 py-12 wrap-anywhere sm:px-8 md:py-20`}>
        {children}
      </main>
      {band ? (
        <div className="flex h-24 justify-center overflow-hidden print:hidden" aria-hidden="true">
          {band}
        </div>
      ) : null}
    </div>
  );
}
