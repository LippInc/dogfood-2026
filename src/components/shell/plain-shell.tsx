import Link from "next/link";
import { ModeToggle } from "@/components/mode-toggle";

/** The public side's frame for pages that belong to no single event: sign-in, sign-up, invites, refusals. */
export function PlainShell({ children, width = "max-w-[1040px]" }: { children: React.ReactNode; width?: string }) {
  return (
    <div className="public min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center px-4 sm:px-8 xl:px-16">
          <Link href="/" className="font-display text-20 uppercase">
            Dogfood portal
          </Link>
          <ModeToggle className="ml-auto" />
        </div>
      </header>
      <main id="main" className={`mx-auto ${width} px-4 py-12 sm:px-8 md:py-20`}>
        {children}
      </main>
    </div>
  );
}
