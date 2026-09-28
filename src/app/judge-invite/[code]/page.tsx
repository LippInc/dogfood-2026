import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PlainShell } from "@/components/shell/plain-shell";
import { Ticket, TicketNote } from "@/components/ticket";
import { buttonVariants } from "@/components/ui/button";
import { formatUtc, plural } from "@/lib/format";
import { currentActor, getGallery, judgeInviteByCode, NotFoundError, type JudgeInviteView } from "@/server/dal";
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
  const alreadyJudge = Boolean(actor?.roles.some((r) => r.eventId === invite.event.id && r.role === "judge"));
  // The invited tracks with their submitted projects, from the public gallery: the stub's number is their sum.
  const gallery = getGallery(invite.event.slug);
  const tracks = invite.tracks.map((name) => ({ name, count: gallery.tracks.find((t) => t.name === name)?.count ?? 0 }));
  const projects = tracks.reduce((n, t) => n + t.count, 0);
  const consoleHref = `/judge/${invite.event.slug}`;
  return (
    <PlainShell width="max-w-[800px]" account={actor ? { name: actor.name } : undefined}>
      <Ticket
        faceId={`judges:${invite.event.id}`}
        stubHead="Admit one · judge"
        stubLabel="In your tracks"
        stubValue={String(projects)}
        stubNote={`${projects === 1 ? "project" : "projects"} across ${plural(tracks.length, "track")}`}
      >
        <p className="label-mono text-ink-3">Judge invitation · {invite.event.name}</p>
        <h1 className="mt-3 font-display text-38">Judge {invite.event.name}</h1>
        <p className="mt-3 text-17 text-ink-2">
          {invite.name ? `${invite.name}, you` : "You"} are invited to score the projects in {tracks.length === 1 ? "this track" : "these tracks"}:
        </p>
        <ul className="mt-4 border-t border-rule">
          {tracks.map((t) => (
            <li key={t.name} className="flex items-baseline justify-between gap-4 border-b border-rule py-2.5">
              <span className="font-medium">{t.name}</span>
              <span className="font-mono text-13 text-ink-3 tnum">{plural(t.count, "project")}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-15 text-ink-2">
          Each project comes with a short rubric. Your scores are yours alone: other judges never see them, and the organizers publish results only when
          judging is done{gallery.event.judgingCloseAt ? `, at the latest ${formatUtc(gallery.event.judgingCloseAt)}` : ""}.
        </p>
        <div className="mt-8 flex flex-col gap-4">
          {invite.state === "used" ? (
            alreadyJudge ? (
              <>
                <TicketNote>This invitation was used, and you judge this event.</TicketNote>
                <Link href={consoleHref} className={`${buttonVariants({ size: "xl" })} self-start`}>
                  Open your judging console
                </Link>
              </>
            ) : (
              <TicketNote>This invitation was already used. Each link admits one judge; ask the organizer for a new one.</TicketNote>
            )
          ) : invite.closed ? (
            <TicketNote flag>{invite.closed} This invitation can no longer be accepted.</TicketNote>
          ) : wrongPerson ? (
            <TicketNote flag>
              This invitation is for <span className="font-medium">{invite.email}</span>, and you are signed in as {actor!.email}. Sign out at the top, then
              sign in with that address.
            </TicketNote>
          ) : actor ? (
            <>
              <p className="text-14 text-ink-2">
                Accepting as <span className="font-medium text-ink">{actor.name}</span> · {actor.email}
              </p>
              <AcceptButton code={code} />
            </>
          ) : (
            <>
              {invite.email ? (
                <p className="text-14 text-ink-2">
                  Use the address the invitation was made for: <span className="font-medium text-ink">{invite.email}</span>
                </p>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <Link href={`/sign-up?next=${encodeURIComponent(here)}`} className={buttonVariants({ size: "xl" })}>
                  Create an account to accept
                </Link>
                <Link href={`/sign-in?next=${encodeURIComponent(here)}`} className={buttonVariants({ variant: "outline", size: "xl" })}>
                  I have an account
                </Link>
              </div>
            </>
          )}
        </div>
      </Ticket>
    </PlainShell>
  );
}
