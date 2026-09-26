import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PlainShell } from "@/components/shell/plain-shell";
import { currentActor, inviteByCode, NotFoundError, type InviteView } from "@/server/dal";
import { JoinButton } from "./join-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Join a team", robots: { index: false } };

export default async function JoinPage({ params }: PageProps<"/join/[code]">) {
  const { code } = await params;
  let invite: InviteView;
  try {
    invite = inviteByCode(code);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const actor = await currentActor();
  const here = `/join/${code}`;
  const full = invite.members >= invite.maxSize;
  return (
    <PlainShell width="max-w-[560px]">
      <p className="label-mono text-ink-3">Invite · {invite.event.name}</p>
      <h1 className="mt-3 font-display text-38">Join {invite.teamName}</h1>
      <p className="mt-3 text-17 text-ink-2">
        {invite.members} of at most {invite.maxSize} members so far.
      </p>
      <div className="mt-8">
        {full ? (
          <p className="border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-14 text-flag">
            This team is full. Ask the captain whether someone is leaving.
          </p>
        ) : actor ? (
          <JoinButton code={code} teamName={invite.teamName} />
        ) : (
          <div className="flex flex-wrap gap-3">
            <Link
              href={`/sign-up?next=${encodeURIComponent(here)}`}
              className="inline-flex h-11 items-center rounded-sm border border-primary bg-primary px-5 text-15 font-medium text-on-primary"
            >
              Create an account to join
            </Link>
            <Link href={`/sign-in?next=${encodeURIComponent(here)}`} className="inline-flex h-11 items-center rounded-sm border border-edge px-5 text-15">
              I have an account
            </Link>
          </div>
        )}
      </div>
    </PlainShell>
  );
}
