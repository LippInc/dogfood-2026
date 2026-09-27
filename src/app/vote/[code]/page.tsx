import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PlainShell } from "@/components/shell/plain-shell";
import { Ticket } from "@/components/ticket";
import { buttonVariants } from "@/components/ui/button";
import { formatUtc } from "@/lib/format";
import { describeVotingCode, listEvents, NotFoundError } from "@/server/dal";
import { EnterButton } from "./enter-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Vote", robots: { index: false } };

/** "27 Oct" for the stub's big line and "2026, 20:27 UTC" for the note under it, from the one written-out date. */
function splitDate(iso: string | null): [string, string] {
  const full = formatUtc(iso); // "27 Oct 2026, 20:27 UTC"
  const m = /^(\d+ \w+) (.*)$/.exec(full);
  return m ? [m[1], m[2]] : [full, ""];
}

// Opening the link only shows this page; the ballot is created by the button, so
// link previews and scanners that fetch the URL never cast or create anything.
export default async function VoteLinkPage({ params }: PageProps<"/vote/[code]">) {
  const { code } = await params;
  let info: ReturnType<typeof describeVotingCode>;
  try {
    info = describeVotingCode(code);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const opensAt = listEvents().find((e) => e.id === info.event.id)?.votingOpenAt ?? null;
  const [stubLabel, when] =
    info.state === "upcoming" ? ["Opens", opensAt] : info.state === "open" ? ["Closes", info.closesAt] : info.state === "closed" ? ["Closed", info.closesAt] : ["Voting window", null];
  const [stubValue, stubNote] = when ? splitDate(when) : ["Not set", undefined];
  const closed = info.state === "closed";
  return (
    <PlainShell width="max-w-[800px]">
      <Ticket faceId={`ballot:${info.event.id}`} stubHead={info.kind === "listed" ? "Admit one · voter" : "One ballot"} stubLabel={stubLabel} stubValue={stubValue} stubNote={stubNote}>
        <p className="label-mono text-ink-3">Community vote · {info.event.name}</p>
        <h1 className="mt-3 font-display text-38">{closed ? "The vote has closed" : "Pick your favourites"}</h1>
        <p className="mt-3 text-17 text-ink-2">
          {closed
            ? `The community vote for ${info.event.name} closed ${formatUtc(info.closesAt)}, and the count is final.`
            : info.kind === "listed"
              ? "This is your personal voting link. It opens your own ballot; please do not share it."
              : "This link lets you vote once, from this browser. The organizers can set aside ballots that look like duplicates."}
        </p>
        {closed ? null : (
          <p className="mt-3 text-15 text-ink-2">
            {info.state === "open"
              ? "You can change your picks until the vote closes. Nobody sees any count until then."
              : info.state === "upcoming"
                ? "You can open your ballot now and pick once voting opens."
                : "The organizers have not set the voting window yet."}
          </p>
        )}
        <div className="mt-8 flex flex-col gap-4">
          {closed ? (
            <Link href={`/events/${info.event.slug}/results`} className={`${buttonVariants({ variant: "outline", size: "xl" })} self-start`}>
              See the community vote on the results page
            </Link>
          ) : (
            <EnterButton code={code} />
          )}
        </div>
      </Ticket>
    </PlainShell>
  );
}
