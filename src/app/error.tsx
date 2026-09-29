"use client";

import Link from "next/link";
import { HelpButton } from "@/components/help/help-panel";
import { AskedPath, CopyValue, StatusSheet } from "@/components/status-sheet";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * The designed page for an unexpected failure under the root layout. A server error keeps
 * its real 500; the digest is the id Next writes next to the error in the server log, so an
 * operator can find what happened. An error with no digest broke in the browser, and the
 * server log has nothing on it.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const digest = error.digest;
  return (
    <StatusSheet
      code="500 · Something broke"
      // the page broke, so it cannot ask who is reading: Help offers what everyone can use
      help={<HelpButton viewer={{ signedIn: false, roles: [], event: null }} variant="public" />}
      title="This page hit an error"
      lead={
        <p>
          The portal ran into something it did not expect. A change you were making was saved whole or not at all,
          never half, so look at the page again before repeating it.
        </p>
      }
      status="500"
      spoil={{ tear: true }}
      rows={[
        { label: "Page", value: <AskedPath />, mono: true },
        digest
          ? { label: "Log id", value: <CopyValue value={digest} label="log id" /> }
          : { label: "Where", value: "In this browser, while drawing the page. The server log has no entry for it." },
        {
          label: "If it stays",
          value: digest
            ? "Send the operator this page's address and the log id; they find the error under it."
            : "Reload the page. If it breaks again, send the operator this page's address.",
        },
      ]}
      actions={
        <>
          <Button size="lg" className="max-sm:h-11" onClick={() => retry()}>
            Try again
          </Button>
          <Link href="/" className={buttonVariants({ variant: "outline", size: "lg", className: "max-sm:h-11" })}>
            Go to the projects
          </Link>
        </>
      }
    />
  );
}
