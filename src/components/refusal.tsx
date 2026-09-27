import Link from "next/link";
import { Suspense } from "react";
import { PlainShell } from "@/components/shell/plain-shell";
import { SignInLink } from "@/components/sign-in-link";
import { StatusFigure } from "@/components/status-figure";

/**
 * The designed page for a refused request. The status code stays real (401, 403,
 * 404 from Next's auth interrupts); this is only what a browser shows with it.
 */
export function Refusal({
  code,
  title,
  children,
  signIn = false,
}: {
  code: string;
  title: string;
  children: React.ReactNode;
  signIn?: boolean;
}) {
  const status = /\d{3}/.exec(code)?.[0] ?? "";
  return (
    <PlainShell width="max-w-[1120px]" mark={status}>
      <div className="grid items-center gap-12 md:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:gap-20">
        <div>
          <p className="label-mono text-accent-ink">{code}</p>
          <h1 className="mt-3 font-display text-38">{title}</h1>
          <div className="mt-4 max-w-[600px] text-17 text-ink-2">{children}</div>
          <div className="mt-8 flex flex-wrap gap-3">
            {signIn ? (
              <Suspense>
                <SignInLink />
              </Suspense>
            ) : null}
            <Link href="/" className="inline-flex h-10 items-center rounded-sm border border-edge px-4 text-15 hover:bg-raised">
              Go to the projects
            </Link>
          </div>
        </div>
        {status ? (
          <div className="max-md:max-w-[320px]">
            <StatusFigure status={status} />
          </div>
        ) : null}
      </div>
    </PlainShell>
  );
}
