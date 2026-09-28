import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Deadline } from "@/components/deadline";
import { Face } from "@/components/face";
import { PublicShell } from "@/components/shell/public-shell";
import { buttonVariants } from "@/components/ui/button";
import { formatUtc, plural } from "@/lib/format";
import { actorNav, currentActor, getBallot, getGallery, NotFoundError, voteCookieName, type BallotView } from "@/server/dal";
import { Ballot } from "./ballot";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Vote" };

/** "18 Oct" for the stub's big line and "2026, 00:06 UTC" under it, from the one written-out date. */
function splitDate(iso: string | null): [string, string] {
  const full = formatUtc(iso);
  const m = /^(\d+ \w+) (.*)$/.exec(full);
  return m ? [m[1], m[2]] : [full, ""];
}

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
  const { state, voter } = ballot;
  const faces = Object.fromEntries(ballot.projects.map((p) => [p.id, <Face key={p.id} id={p.id} />]));
  const slotFaces = Object.fromEntries(ballot.projects.map((p) => [p.id, <Face key={p.id} id={p.id} cols={32} rows={18} />]));
  const canVote = state === "open" && voter !== null && !voter.voided;
  const here = `/events/${event.slug}/vote`;
  const signIn = `/sign-in?next=${encodeURIComponent(here)}`;
  const results = `/events/${event.slug}/results`;
  const closed = state === "closed";

  // the stub: the one date a voter needs, big, with the reader's own time and what is left under it
  const stubAt = state === "upcoming" ? ballot.event.votingOpenAt : ballot.event.votingCloseAt;
  const stubLabel = state === "upcoming" ? "Voting opens" : state === "open" ? "Voting closes" : "Voting closed";
  const [stubDay, stubRest] = splitDate(stubAt);

  // what the ballot's bar offers a request that cannot vote
  const cta = voter?.voided
    ? { text: "This ballot is set aside." }
    : state === "upcoming"
      ? { text: `Voting opens ${formatUtc(ballot.event.votingOpenAt)}.` }
      : voter === null && !actor && ballot.modes.includes("account")
        ? { href: signIn, label: "Sign in to vote" }
        : voter === null
          ? { text: "Open the organizers’ voting link to vote." }
          : undefined;

  // once voting has closed, only a voter's own picks are worth showing
  const projects = closed ? ballot.projects.filter((p) => ballot.picks.includes(p.id)) : ballot.projects;
  const showBallot = state === "open" || state === "upcoming" || (closed && voter !== null && projects.length > 0);
  const many = ballot.votesPerVoter === 1 ? "your favourite project" : `up to ${ballot.votesPerVoter} favourite projects`;

  return (
    <PublicShell event={event} active="vote" signedInAs={actor?.name ?? null} links={actorNav(actor, event.id)}>
      <div className="flex flex-col gap-3 pt-8 md:flex-row md:items-end md:justify-between md:pt-10">
        <h1 className="font-display text-[48px] leading-[52px] md:text-64">{closed ? "The vote is closed" : "Vote"}</h1>
        {state === "not_set" ? null : (
          <p className="label-mono tnum text-ink-2 tracking-[0.06em] sm:tracking-[0.12em] md:pb-2">
            Community vote / {plural(ballot.votesPerVoter, "vote")} each / {plural(ballot.projects.length, "project")}
          </p>
        )}
      </div>

      <div className={`mt-6 grid items-start gap-6 md:mt-8 ${state === "not_set" ? "" : "md:grid-cols-[minmax(0,1fr)_300px] md:gap-10"}`}>
        <div className="flex min-w-0 flex-col gap-6">
          <p className="max-w-[680px] font-serif text-17 leading-7 text-ink-2">
            {state === "not_set"
              ? "This event has no community vote."
              : state === "upcoming"
                ? `Once voting opens, pick ${many}. Here is what will be on the ballot.`
                : state === "open"
                  ? `Pick ${many}. Each pick saves at once, and you can change it until voting closes. The list is shuffled for you, so no project gets the top spot on every ballot. Only the organizers see the count before voting closes.`
                  : voter !== null && projects.length
                    ? `The community vote for ${event.name} is over, and the count is final. These are the picks on your ballot.`
                    : voter !== null
                      ? `The community vote for ${event.name} is over, and the count is final. Your ballot had no picks.`
                      : `The community vote for ${event.name} is over, and the count is final.`}
          </p>

          {closed ? (
            <Link href={results} className={`${buttonVariants({ variant: "outline", size: "xl" })} self-start`}>
              See the community vote
            </Link>
          ) : null}

          {(state === "upcoming" || state === "open") && voter === null ? (
            <section aria-labelledby="how-title" className="max-w-[680px] rounded-sm border border-rule bg-surface p-5 sm:p-6">
              <h2 id="how-title" className="label-mono text-accent-ink">
                How to vote
              </h2>
              {ballot.modes.includes("account") ? (
                actor ? (
                  <p className="mt-3 text-15">Your account can vote: pick below.</p>
                ) : (
                  <>
                    <p className="mt-3 text-15">Anyone with an account on this portal can vote.</p>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <Link href={signIn} className={buttonVariants({ variant: "primary", size: "lg" })}>
                        Sign in to vote
                      </Link>
                      <Link href={`/sign-up?next=${encodeURIComponent(here)}`} className={buttonVariants({ variant: "outline", size: "lg" })}>
                        Create an account
                      </Link>
                    </div>
                  </>
                )
              ) : null}
              {ballot.modes.includes("listed") || ballot.modes.includes("link") ? (
                <ul className={`flex flex-col gap-2 text-15 text-ink-2 ${ballot.modes.includes("account") ? "mt-5 border-t border-rule pt-4" : "mt-3"}`}>
                  {ballot.modes.includes("listed") ? <li>If the organizers sent you a personal voting link, open it: it brings you back here with your ballot.</li> : null}
                  {ballot.modes.includes("link") ? <li>Or open the event&rsquo;s voting link, shared by the organizers.</li> : null}
                </ul>
              ) : null}
              {ballot.modes.length === 0 ? <p className="mt-3 text-15">The organizers have not chosen who may vote yet.</p> : null}
            </section>
          ) : null}

          {voter?.voided ? (
            <p className="max-w-[680px] border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-14 text-flag">
              The organizers set this ballot aside as a suspected duplicate, so its picks do not count.
            </p>
          ) : voter?.kind === "link" && !closed ? (
            <p className="max-w-[680px] rounded-xs border border-rule bg-sunken px-4 py-3 text-14 text-ink-2">
              You are voting through the event&rsquo;s open link. Ballots from it are counted apart from those of signed-in accounts and the voter
              list, {ballot.countLink ? "and the organizers chose to include them in the count." : "and shown next to the count without changing any place."}
            </p>
          ) : null}
        </div>

        {state === "not_set" ? null : (
          <aside aria-label={stubLabel} className="flex gap-5 rounded-sm border border-rule bg-surface p-5 md:flex-col">
            <div className="w-24 shrink-0 self-start overflow-hidden rounded-xs border border-rule md:w-auto md:self-stretch" aria-hidden="true">
              <Face id={`ballot:${event.id}`} cols={32} rows={18} />
            </div>
            <div className="min-w-0">
              <p className="label-mono text-ink-3">{stubLabel}</p>
              <p className="mt-1 font-display text-38 leading-none tnum">{stubDay}</p>
              <div className="mt-2">
                {closed ? <p className="text-15 font-medium">{stubRest}</p> : stubAt ? <Deadline iso={stubAt} utcLabel={stubRest} /> : null}
              </div>
            </div>
          </aside>
        )}
      </div>

      {showBallot ? (
        <div className="mt-10">
          <Ballot
            eventId={event.id}
            projects={projects}
            initialPicks={ballot.picks}
            max={ballot.votesPerVoter}
            canVote={canVote}
            cta={cta}
            faces={faces}
            slotFaces={slotFaces}
          />
        </div>
      ) : null}
    </PublicShell>
  );
}
