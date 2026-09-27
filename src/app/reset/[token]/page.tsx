import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PlainShell } from "@/components/shell/plain-shell";
import { describePasswordReset, HttpError, NotFoundError } from "@/server/dal";
import { ResetForm } from "./reset-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set a new password", referrer: "no-referrer" };

export default async function ResetPage({ params }: PageProps<"/reset/[token]">) {
  const { token } = await params;
  let who: { email: string; name: string } | null = null;
  let gone: string | null = null;
  try {
    who = describePasswordReset(token);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof HttpError && err.status === 410) gone = err.message;
    else throw err;
  }
  return (
    <PlainShell width="max-w-[720px]">
      {who ? (
        <>
          <p className="label-mono text-ink-3">Password reset</p>
          <h1 className="mt-2 font-display text-38">Set a new password</h1>
          <p className="mt-3 max-w-[560px] text-15 text-ink-2">
            For <strong className="font-semibold text-ink">{who.email}</strong>. This link works once. Saving signs you in here and signs this account out
            everywhere else.
          </p>
          <div className="mt-8">
            <ResetForm token={token} />
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
