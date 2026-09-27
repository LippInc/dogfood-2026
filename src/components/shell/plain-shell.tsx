import Link from "next/link";
import { ModeToggle } from "@/components/mode-toggle";

/**
 * The public side's frame for pages that belong to no single event: the event list,
 * sign-in, sign-up, invites, refusals. `account` adds the top bar's account controls:
 * left out, none (the sign-in and sign-up pages); null, Sign in; a name, Sign out.
 */
export function PlainShell({
  children,
  width = "max-w-[1040px]",
  account,
}: {
  children: React.ReactNode;
  width?: string;
  account?: { name: string } | null;
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
      <main id="main" className={`mx-auto ${width} px-4 py-12 wrap-anywhere sm:px-8 md:py-20`}>
        {children}
      </main>
    </div>
  );
}
