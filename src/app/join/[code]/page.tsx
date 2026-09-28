import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PlainShell } from "@/components/shell/plain-shell";
import { Seats, Ticket, TicketNote } from "@/components/ticket";
import { buttonVariants } from "@/components/ui/button";
import { formatUtc } from "@/lib/format";
import { currentActor, getMyWork, inviteByCode, listEvents, NotFoundError, type InviteView } from "@/server/dal";
import { JoinButton } from "./join-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Join a team", robots: { index: false } };

/** The same window the server checks on join (authz team.join), so the page says what the button would get. */
function teamWindow(eventId: string, now = Date.now()) {
  const event = listEvents().find((e) => e.id === eventId);
  const closeAt = event?.submissionsCloseAt ?? null;
  const openAt = event?.submissionsOpenAt ?? null;
  const closed = closeAt !== null && now >= Date.parse(closeAt);
  return { closeAt, openAt, closed, notYet: !closed && openAt !== null && now < Date.parse(openAt) };
}

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
  const { closeAt, openAt, closed, notYet } = teamWindow(invite.event.id);
  const mine = actor ? getMyWork(actor, invite.event.slug).team : null;
  const project = `/events/${invite.event.slug}/my-project`;
  return (
    <PlainShell width="max-w-[800px]" account={actor ? { name: actor.name } : undefined}>
      <Ticket
        faceId={invite.teamId}
        stubHead="Admit one"
        stubLabel="Seats taken"
        stubValue={`${invite.members} / ${invite.maxSize}`}
        stubArt={<Seats taken={invite.members} of={invite.maxSize} />}
      >
        <p className="label-mono text-ink-3">Team invite · {invite.event.name}</p>
        <h1 className="mt-3 font-display text-38">Join {invite.teamName}</h1>
        <p className="mt-3 text-17 text-ink-2">
          A team in <Link href={`/events/${invite.event.slug}`} className="underline decoration-edge underline-offset-4 hover:decoration-ink">{invite.event.name}</Link>.
          Members build and hand in one project together
          {closeAt && !closed ? `, until submissions close ${formatUtc(closeAt)}` : ""}.
        </p>
        <div className="mt-8 flex flex-col gap-4">
          {mine?.id === invite.teamId ? (
            <>
              <TicketNote>You are on {invite.teamName} already.</TicketNote>
              <Link href={project} className={`${buttonVariants({ size: "xl" })} self-start`}>
                Open your team&apos;s project
              </Link>
            </>
          ) : mine ? (
            <>
              <TicketNote>
                You are on {mine.name} in this event, and a person can be on one team only. To join {invite.teamName}, leave {mine.name} first on your
                project page (its only member dissolves it instead).
              </TicketNote>
              <Link href={project} className={`${buttonVariants({ variant: "outline", size: "xl" })} self-start`}>
                Open your project page
              </Link>
            </>
          ) : closed ? (
            <>
              <TicketNote>Teams were fixed when submissions closed, {formatUtc(closeAt)}. This link no longer adds anyone.</TicketNote>
              <Link href={`/events/${invite.event.slug}`} className={`${buttonVariants({ variant: "outline", size: "xl" })} self-start`}>
                See the projects
              </Link>
            </>
          ) : full ? (
            <TicketNote>
              {invite.teamName} has all {invite.maxSize} members this event allows. Ask the captain whether someone is leaving.
            </TicketNote>
          ) : (
            <>
              {notYet ? <TicketNote>Teams can form from {formatUtc(openAt)}. Until then this link waits.</TicketNote> : null}
              {notYet && actor ? null : actor ? (
                <>
                  <p className="text-14 text-ink-2">
                    Joining as <span className="font-medium text-ink">{actor.name}</span> · {actor.email}
                  </p>
                  <JoinButton code={code} teamName={invite.teamName} />
                </>
              ) : (
                <div className="flex flex-wrap gap-3">
                  <Link href={`/sign-up?next=${encodeURIComponent(here)}`} className={buttonVariants({ size: "xl" })}>
                    Create an account to join
                  </Link>
                  <Link href={`/sign-in?next=${encodeURIComponent(here)}`} className={buttonVariants({ variant: "outline", size: "xl" })}>
                    I have an account
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      </Ticket>
    </PlainShell>
  );
}
