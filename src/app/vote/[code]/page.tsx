import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlainShell } from "@/components/shell/plain-shell";
import { describeVotingCode, NotFoundError } from "@/server/dal";
import { EnterButton } from "./enter-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Vote", robots: { index: false } };

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
  return (
    <PlainShell width="max-w-[560px]">
      <p className="label-mono text-ink-3">Community vote · {info.event.name}</p>
      <h1 className="mt-3 font-display text-38">Pick your favourites</h1>
      <p className="mt-3 text-17 text-ink-2">
        {info.kind === "listed"
          ? "This is your personal voting link. It opens your own ballot; please do not share it."
          : "This link lets you vote once, from this browser. The organizers can set aside ballots that look like duplicates."}
      </p>
      <p className="mt-3 text-15 text-ink-2">
        {info.state === "open"
          ? "Voting is open. You can change your picks until it closes; nobody sees any count until then."
          : info.state === "upcoming"
            ? "Voting has not opened yet. You can open your ballot now and pick when it opens."
            : info.state === "closed"
              ? "Voting has closed."
              : "The organizers have not set the voting window yet."}
      </p>
      <div className="mt-8">
        <EnterButton code={code} />
      </div>
    </PlainShell>
  );
}
