import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PlainShell } from "@/components/shell/plain-shell";
import { describeClaim, HttpError, NotFoundError } from "@/server/dal";
import { ClaimForm } from "./claim-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set your password", referrer: "no-referrer" };

export default async function ClaimPage({ params }: PageProps<"/claim/[token]">) {
  const { token } = await params;
  let claim: ReturnType<typeof describeClaim> | null = null;
  let gone: string | null = null;
  try {
    claim = describeClaim(token);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof HttpError && err.status === 410) gone = err.message;
    else throw err;
  }
  return (
    <PlainShell width="max-w-[720px]">
      {claim ? (
        <>
          <p className="label-mono text-ink-3">{claim.eventName}</p>
          <h1 className="mt-2 font-display text-38">Set your password</h1>
          <p className="mt-3 max-w-[560px] text-15 text-ink-2">
            The organizers added <strong className="font-semibold text-ink">{claim.email}</strong> to {claim.eventName}. Choose a password to sign
            in; this link works once.
          </p>
          <div className="mt-8">
            <ClaimForm token={token} name={claim.name} />
          </div>
        </>
      ) : (
        <>
          <h1 className="font-display text-38">This link no longer works</h1>
          <p className="mt-3 max-w-[560px] text-15 text-ink-2">{gone}</p>
          <p className="mt-6">
            <Link href="/sign-in" className="underline underline-offset-4">
              Sign in
            </Link>
          </p>
        </>
      )}
    </PlainShell>
  );
}
