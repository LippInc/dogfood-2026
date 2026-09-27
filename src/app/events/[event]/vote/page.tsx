import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Face } from "@/components/face";
import { PublicShell } from "@/components/shell/public-shell";
import { formatUtc } from "@/lib/format";
import { actorNav, currentActor, getBallot, getGallery, NotFoundError, voteCookieName, type BallotView } from "@/server/dal";
import { Ballot } from "./ballot";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Vote" };

export default async function VotePage({ params }: PageProps<"/events/[event]/vote">) {
  const { event: key } = await params;
  const actor = await currentActor();
  let gallery: ReturnType<typeof getGallery>;
  let ballot: BallotView;
  try {
    gallery = getGallery(key);
    const token = (await cookies()).get(voteCookieName(gallery.event.id))?.value ?? null;
    ballot = getBallot(actor, gallery.event.id, token);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const { event } = gallery;
  const faces = Object.fromEntries(ballot.projects.map((p) => [p.id, <Face key={p.id} id={p.id} className="block h-[68px] w-[120px]" />]));
  const canVote = ballot.state === "open" && ballot.voter !== null && !ballot.voter.voided;
  const here = `/events/${event.slug}/vote`;

  return (
    <PublicShell event={event} active="vote" signedInAs={actor?.name ?? null} links={actorNav(actor, event.id)}>
      <div className="pt-10 pb-6">
        <h1 className="font-display text-[48px] leading-[52px] md:text-64">Vote</h1>
        <p className="mt-4 max-w-[760px] text-17 text-ink-2">
          {ballot.state === "not_set"
            ? "This event has no community vote."
            : ballot.state === "upcoming"
              ? `Voting opens ${formatUtc(ballot.event.votingOpenAt, { weekday: true })} and closes ${formatUtc(ballot.event.votingCloseAt, { weekday: true })}.`
              : ballot.state === "open"
                ? `${ballot.votesPerVoter === 1 ? "Pick your favourite" : `Pick up to ${ballot.votesPerVoter} favourites`} before ${formatUtc(ballot.event.votingCloseAt, { weekday: true })}. The list is shuffled for you, so no project gets the top spot on every ballot. Only the organizers see the count before voting closes.`
                : `Voting closed ${formatUtc(ballot.event.votingCloseAt, { weekday: true })}.`}
        </p>
        {ballot.state === "closed" ? (
          <p className="mt-3 text-15">
            <Link href={`/events/${event.slug}/results`} className="underline underline-offset-4">
              See the community vote on the results page
            </Link>
          </p>
        ) : null}
      </div>
      {ballot.state !== "not_set" && ballot.voter === null ? (
        <section aria-labelledby="how-title" className="mb-8 max-w-[760px] border-l-[3px] border-accent bg-surface px-5 py-4">
          <h2 id="how-title" className="text-17 font-semibold">
            How to vote here
          </h2>
          <ul className="mt-2 flex flex-col gap-2 text-15">
            {ballot.modes.includes("account") ? (
              <li>
                {actor ? (
                  "Your account can vote: pick below."
                ) : (
                  <>
                    <Link href={`/sign-in?next=${encodeURIComponent(here)}`} className="font-medium underline underline-offset-4">
                      Sign in
                    </Link>{" "}
                    or{" "}
                    <Link href={`/sign-up?next=${encodeURIComponent(here)}`} className="font-medium underline underline-offset-4">
                      create an account
                    </Link>{" "}
                    to vote.
                  </>
                )}
              </li>
            ) : null}
            {ballot.modes.includes("listed") ? <li>If the organizers sent you a personal voting link, open it: it brings you back here with your ballot.</li> : null}
            {ballot.modes.includes("link") ? <li>Open the event&rsquo;s voting link, shared by the organizers.</li> : null}
            {ballot.modes.length === 0 ? <li>The organizers have not chosen who may vote yet.</li> : null}
          </ul>
        </section>
      ) : null}
      {ballot.voter?.voided ? (
        <p className="mb-6 max-w-[760px] border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-14 text-flag">
          The organizers set this ballot aside as a suspected duplicate, so its picks do not count.
        </p>
      ) : null}
      {ballot.state === "not_set" ? null : (
        <Ballot eventId={event.id} projects={ballot.projects} initialPicks={ballot.picks} max={ballot.votesPerVoter} canVote={canVote} faces={faces} />
      )}
    </PublicShell>
  );
}
