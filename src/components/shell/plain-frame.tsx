import Link from "next/link";
import { ModeToggle } from "@/components/mode-toggle";

/**
 * The markup of PlainShell (plain-shell.tsx), which pages use. It stays free of
 * server-only code so the error boundary, a client component, can wear the same frame;
 * `mark` is the slot PlainShell fills with the page's mark.
 */
export function PlainFrame({
  children,
  width = "max-w-[1040px]",
  account,
  mark,
}: {
  children: React.ReactNode;
  width?: string;
  account?: { name: string } | null;
  mark?: React.ReactNode;
}) {
  return (
    <div className="public min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-3 px-4 sm:px-8 xl:px-16">
          <Link href="/" className="font-display text-20 uppercase">
            Dogfood portal
          </Link>
          <ModeToggle className="ml-auto" />
          {account === undefined ? null : account ? (
            <>
              <span title={account.name} className="hidden max-w-56 truncate text-14 font-medium sm:block">
                {account.name}
              </span>
              <form action="/api/auth/sign-out" method="post">
                <button className="h-10 rounded-sm border border-edge px-4 text-14 hover:bg-surface">Sign out</button>
              </form>
            </>
          ) : (
            <Link href="/sign-in" className="inline-flex h-10 items-center rounded-sm border border-edge px-4 text-15 hover:bg-surface">
              Sign in
            </Link>
          )}
        </div>
      </header>
      {mark ? (
        <div className="relative mx-auto max-w-[1440px] print:hidden" aria-hidden="true">
          {mark}
        </div>
      ) : null}
      <main id="main" className={`mx-auto ${width} px-4 py-12 wrap-anywhere sm:px-8 md:py-20`}>
        {children}
      </main>
    </div>
  );
}
