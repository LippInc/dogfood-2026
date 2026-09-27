"use client";

import Link from "next/link";
import { PlainShell } from "@/components/shell/plain-shell";
import { Button } from "@/components/ui/button";

/**
 * The designed page for an unexpected failure under the root layout. The status
 * stays a real 500; the digest is the id Next writes next to the error in the
 * server log, so an operator can find what happened.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PlainShell width="max-w-2xl">
      <p className="label-mono text-accent-ink">500 · Something broke</p>
      <h1 className="mt-3 font-display text-38">This page hit an error</h1>
      <div className="mt-4 space-y-3 text-17 text-ink-2">
        <p>
          The server ran into something it did not expect. A change you were making was saved whole or not at all,
          never half, so look at the page again before repeating it.
        </p>
        {error.digest ? (
          <p className="text-15">
            For the operator: the server log has this error under <code className="font-mono">{error.digest}</code>.
          </p>
        ) : null}
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button size="lg" onClick={() => retry()}>
          Try again
        </Button>
        <Link href="/" className="inline-flex h-10 items-center rounded-sm border border-edge px-4 text-15 hover:bg-raised">
          Go to the projects
        </Link>
      </div>
    </PlainShell>
  );
}
