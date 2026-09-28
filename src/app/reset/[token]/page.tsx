import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Consequences, GoneLink, LinkTicket } from "@/components/one-time-link";
import { describePasswordReset, HttpError, NotFoundError } from "@/server/dal";
import { ResetForm } from "./reset-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set a new password", referrer: "no-referrer" };

export default async function ResetPage({ params }: PageProps<"/reset/[token]">) {
  const { token } = await params;
  let who: { email: string; name: string } | null = null;
  let gone: { code: string; message: string } | null = null;
  try {
    who = describePasswordReset(token);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof HttpError && err.status === 410) gone = { code: err.code, message: err.message };
    else throw err;
  }
  if (!who) return <GoneLink kind="reset" token={token} code={gone!.code} message={gone!.message} />;
  return (
    <LinkTicket kind="reset" token={token} works>
      <p className="label-mono text-ink-3">Password reset · one-time link</p>
      <h1 className="mt-3 font-display text-38">Set a new password</h1>
      <p className="mt-3 text-17 text-ink-2">
        For <strong className="font-semibold text-ink">{who.name}</strong> · {who.email}
      </p>
      <div className="mt-6">
        <Consequences
          items={[
            "Signs you in here.",
            <>
              Signs <span className="font-medium text-ink">{who.email}</span> out everywhere else, so whoever knew the old password is out.
            </>,
            "Leaves the account's API tokens working: revoke any you no longer trust on API tokens.",
            "Stops this link. It works once.",
          ]}
        />
      </div>
      <div className="mt-6">
        <ResetForm token={token} />
      </div>
    </LinkTicket>
  );
}
