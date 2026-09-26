import Link from "next/link";
import { Suspense } from "react";
import { PlainShell } from "@/components/shell/plain-shell";
import { SignInLink } from "@/components/sign-in-link";

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
  return (
    <PlainShell width="max-w-2xl">
      <p className="label-mono text-accent-ink">{code}</p>
      <h1 className="mt-3 font-display text-38">{title}</h1>
      <div className="mt-4 text-17 text-ink-2">{children}</div>
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
    </PlainShell>
  );
}
