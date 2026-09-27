import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { LiveRefresh } from "@/components/live-refresh";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { formatUtc } from "@/lib/format";
import { guardPage, utcInput } from "@/lib/page-guard";
import { currentActor, getVotingAdmin } from "@/server/dal";
import { VoidForm, VoterListForm, VotingLinkForm, VotingSettingsForm } from "./forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Community vote" };

const KIND: Record<string, string> = { account: "accounts", listed: "voter list", link: "open link" };

export default async function VotingPage({ params }: PageProps<"/organize/[event]/voting">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const v = guardPage(() => getVotingAdmin(actor, key));
  const { event } = v;
  const closed = v.state === "closed";
  return (
    <WorkShell
      eventName={event.name}
      eventHref={`/organize/${event.slug}`}
      tabs={organizerTabs(event.slug, "Voting")}
      tools={<LiveRefresh />}
      person={actor.name}
      role="Organizer"
    >
      <div className="flex flex-col gap-8">
        <header>
          <h1 className="text-24 font-semibold">Community vote</h1>
          <p className="mt-2 max-w-[860px] text-15 text-ink-2">
            {v.state === "not_set"
              ? "Not set up. Choose a window and who may vote."
              : v.state === "upcoming"
                ? `Opens ${formatUtc(event.votingOpenAt)}, closes ${formatUtc(event.votingCloseAt)}.`
                : v.state === "open"
                  ? `Open until ${formatUtc(event.votingCloseAt)}. The count below is live and only organizers see it; everyone else sees it when the window closes.`
                  : `Closed ${formatUtc(event.votingCloseAt)}. The counts are public on the results page, and final: the window cannot move and no ballot can be set aside or restored.`}
          </p>
        </header>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-3">
          <section aria-labelledby="turnout-title" className="rounded-sm border border-rule bg-surface p-5">
            <h2 id="turnout-title" className="text-15 font-semibold">
              Turnout
            </h2>
            <p className="mt-3 flex items-baseline gap-2">
              <span className="text-38 leading-none font-semibold tnum">{v.turnout.ballots}</span>
              <span className="text-13 text-ink-2">ballots counted{v.turnout.voided ? ` · ${v.turnout.voided} set aside` : ""}</span>
            </p>
            <ul className="mt-3 flex flex-col gap-1 text-14 text-ink-2">
              {v.turnout.byKind.map((k) => (
                <li key={k.kind}>
                  {KIND[k.kind]}: <span className="tnum">{k.ballots}</span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="dup-title" className="rounded-sm border border-rule bg-surface p-5 lg:col-span-2">
            <h2 id="dup-title" className="text-15 font-semibold">
              Suspected duplicates
            </h2>
            <p className="mt-1 text-14 text-ink-2">
              Ballots from the same network address and browser.{" "}
              {closed ? "Voting has closed, so they stay as they are." : "Look at them; set one aside only with a reason."}
            </p>
            {v.suspected.length === 0 ? (
              <p className="mt-3 text-14 text-ink-2">None so far.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-3">
                {v.suspected.map((g) => (
                  <li key={g.key} className="rounded-sm border border-rule border-l-[3px] border-l-flag-bar p-3">
                    <p className="text-13 text-ink-2">
                      {g.voters.length} ballots, same address and browser <span className="font-mono">#{g.key}</span>
                    </p>
                    <ul className="mt-2 flex flex-col gap-2">
                      {g.voters.map((voter) => (
                        <li key={voter.id} className="flex flex-wrap items-center justify-between gap-2 text-14">
                          <span className={voter.voided ? "text-ink-3 line-through" : ""}>
                            <span className="font-mono text-12">{voter.id}</span> · {KIND[voter.kind]} · {voter.picks} {voter.picks === 1 ? "pick" : "picks"} · from{" "}
                            {formatUtc(voter.createdAt)}
                          </span>
                          {closed ? (
                            voter.voided ? <span className="text-13 text-ink-2">set aside</span> : null
                          ) : (
                            // keyed on voided, so the form starts closed again after each change
                            <VoidForm key={`${voter.id}:${voter.voided}`} eventSlug={event.slug} voterId={voter.id} voided={voter.voided} />
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {v.tally ? (
          <section aria-labelledby="tally-title">
            <h2 id="tally-title" className="text-17 font-semibold">
              {v.state === "open" ? "The count so far" : "The count"}
            </h2>
            {v.state === "open" ? <p className="mt-1 text-14 text-ink-2">Live, and hidden from everyone but organizers until the window closes.</p> : null}
            <ol className="mt-3 divide-y divide-rule rounded-sm border border-rule bg-surface">
              {v.tally.map((t) => (
                <li key={t.projectId} className="flex items-baseline justify-between gap-3 px-4 py-2 text-14">
                  <span className="min-w-0 wrap-anywhere">
                    <span className="inline-block w-8 text-ink-2 tnum">{t.place}</span>
                    <span className="font-medium">{t.title}</span> <span className="text-ink-2">· {t.teamName}</span>
                  </span>
                  <span className="shrink-0 font-semibold tnum">{t.votes}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-3">
          <section aria-labelledby="settings-title" className="rounded-sm border border-rule bg-surface p-5 lg:col-span-2">
            <h2 id="settings-title" className="mb-4 text-17 font-semibold">
              Window and voters
            </h2>
            {closed ? (
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-14">
                <dt className="text-ink-2">Opened</dt>
                <dd>{formatUtc(event.votingOpenAt)}</dd>
                <dt className="text-ink-2">Closed</dt>
                <dd>{formatUtc(event.votingCloseAt)}</dd>
                <dt className="text-ink-2">Who could vote</dt>
                <dd>{v.settings.modes.map((m) => KIND[m]).join(", ") || "nobody"}</dd>
                <dt className="text-ink-2">Favourites per voter</dt>
                <dd className="tnum">{v.settings.votesPerVoter}</dd>
              </dl>
            ) : (
              <VotingSettingsForm
                eventSlug={event.slug}
                openAt={utcInput(event.votingOpenAt)}
                closeAt={utcInput(event.votingCloseAt)}
                modes={v.settings.modes}
                votesPerVoter={v.settings.votesPerVoter}
              />
            )}
          </section>
          <div className="flex flex-col gap-6">
            <section aria-labelledby="link-title" className="rounded-sm border border-rule bg-surface p-5">
              <h2 id="link-title" className="mb-3 text-17 font-semibold">
                Open voting link
              </h2>
              {closed ? <p className="text-14 text-ink-2">Voting has closed; the link only says so.</p> : <VotingLinkForm eventSlug={event.slug} active={v.settings.linkActive} />}
            </section>
            <section aria-labelledby="list-title" className="rounded-sm border border-rule bg-surface p-5">
              <h2 id="list-title" className="mb-1 text-17 font-semibold">
                Voter list
              </h2>
              <p className="mb-3 text-14 text-ink-2">
                {v.listed.length} on the list, {v.listed.filter((l) => l.voted).length} voted.
                {closed ? "" : " The portal sends no email: copy the links and send them yourself."}
              </p>
              {closed ? null : <VoterListForm eventSlug={event.slug} />}
            </section>
          </div>
        </div>
      </div>
    </WorkShell>
  );
}
