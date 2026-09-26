import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PlainShell } from "@/components/shell/plain-shell";
import { currentActor, judgeInviteByCode, NotFoundError, type JudgeInviteView } from "@/server/dal";
import { AcceptButton } from "./accept-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Judge invitation", robots: { index: false } };

export default async function JudgeInvitePage({ params }: PageProps<"/judge-invite/[code]">) {
  const { code } = await params;
  let invite: JudgeInviteView;
  try {
    invite = judgeInviteByCode(code);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const actor = await currentActor();
  const here = `/judge-invite/${code}`;
  const wrongPerson = Boolean(actor && invite.email && actor.email.toLowerCase() !== invite.email);
  return (
    <PlainShell width="max-w-[560px]">
      <p className="label-mono text-ink-3">Judge invitation · {invite.event.name}</p>
      <h1 className="mt-3 font-display text-38">Judge {invite.event.name}</h1>
      <p className="mt-3 text-17 text-ink-2">
        {invite.name ? `${invite.name}, you` : "You"} are invited to score the projects in {invite.tracks.length === 1 ? "the track" : "these tracks"}:{" "}
        <span className="font-medium text-ink">{invite.tracks.join(", ")}</span>.
      </p>
      <p className="mt-3 text-15 text-ink-2">
        Each project comes with a short rubric. Your scores are yours alone: other judges never see them, and the organizers publish results only when
        judging is done.
      </p>
      <div className="mt-8">
        {invite.state === "used" ? (
          <p className="border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-14 text-flag">
            This invitation was already used. If that was you, open <Link href={`/judge/${invite.event.slug}`} className="underline">your judging console</Link>;
            otherwise ask the organizer for a new link.
          </p>
        ) : wrongPerson ? (
          <p className="border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-14 text-flag">
            This invitation is for {invite.email}, and you are signed in as {actor!.email}. Sign out and sign in with that address.
          </p>
        ) : actor ? (
          <AcceptButton code={code} />
        ) : (
          <div className="flex flex-col gap-3">
            {invite.email ? <p className="text-14 text-ink-2">Use the address the invitation was made for: {invite.email}.</p> : null}
            <div className="flex flex-wrap gap-3">
              <Link
                href={`/sign-up?next=${encodeURIComponent(here)}`}
                className="inline-flex h-11 items-center rounded-sm border border-primary bg-primary px-5 text-15 font-medium text-on-primary"
              >
                Create an account to accept
              </Link>
              <Link href={`/sign-in?next=${encodeURIComponent(here)}`} className="inline-flex h-11 items-center rounded-sm border border-edge px-5 text-15">
                I have an account
              </Link>
            </div>
          </div>
        )}
      </div>
    </PlainShell>
  );
}
