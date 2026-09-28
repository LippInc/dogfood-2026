import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GoneLink, LinkTicket } from "@/components/one-time-link";
import { describeClaim, HttpError, NotFoundError } from "@/server/dal";
import { ClaimForm } from "./claim-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set your password", referrer: "no-referrer" };

export default async function ClaimPage({ params }: PageProps<"/claim/[token]">) {
  const { token } = await params;
  let claim: ReturnType<typeof describeClaim> | null = null;
  let gone: { code: string; message: string } | null = null;
  try {
    claim = describeClaim(token);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof HttpError && err.status === 410) gone = { code: err.code, message: err.message };
    else throw err;
  }
  if (!claim) return <GoneLink kind="claim" token={token} code={gone!.code} message={gone!.message} />;
  return (
    <LinkTicket kind="claim" token={token} works>
      <p className="label-mono text-ink-3">Personal link · {claim.eventName}</p>
      <h1 className="mt-3 font-display text-38">Set your password</h1>
      <p className="mt-3 text-17 text-ink-2">
        The organizers of {claim.eventName} added <strong className="font-semibold text-ink">{claim.email}</strong> to the event. The account is
        there already; choose a password and it is yours.
      </p>
      <div className="mt-6">
        <ClaimForm token={token} name={claim.name} eventName={claim.eventName} />
      </div>
    </LinkTicket>
  );
}
