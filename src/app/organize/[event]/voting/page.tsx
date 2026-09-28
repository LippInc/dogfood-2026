import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { Face } from "@/components/face";
import { LiveRefresh } from "@/components/live-refresh";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { formatUtc } from "@/lib/format";
import { guardPage, utcInput } from "@/lib/page-guard";
import { currentActor, emailIsOn, getVotingAdmin } from "@/server/dal";
import { NewVoterLinkForm, VoidForm, VoterListForm, VotingLinkForm, VotingSettingsForm } from "./forms";
import { VoteCountChanges, VoteRuleChanges } from "@/components/results/vote-rule-changes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Community vote" };

const KIND: Record<string, string> = { account: "accounts", listed: "voter list", link: "open link" };
/** How the audit log names a voter who is not a signed-in account, followed by the id's last six characters. */
const VOTER: Record<string, string> = { account: "Account voter", listed: "Listed voter", link: "Link voter" };
/** One fill per channel in the turnout bar, told apart without colour: solid ink, solid ink-2, hatched. */
const CHANNEL: Record<string, string> = {
  account: "bg-ink",
  listed: "bg-ink-2",
  link: "border border-ink-3 bg-[repeating-linear-gradient(135deg,var(--ink-3)_0_2px,transparent_2px_5px)]",
};

/** The count's rows: place, face, title, bar (wide screens), votes; and the open link's column when it is a way in. */
const COUNT_ROW = "grid-cols-[28px_32px_minmax(0,1fr)_40px] md:grid-cols-[28px_32px_minmax(0,300px)_minmax(0,1fr)_40px]";
const COUNT_ROW_LINK = "grid-cols-[28px_32px_minmax(0,1fr)_40px_64px] md:grid-cols-[28px_32px_minmax(0,300px)_minmax(0,1fr)_40px_120px]";

/** "1 d 22 h", "5 h 12 min", "40 min": a stretch of time, to the minute. */
function stretch(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return d ? `${d} d ${h} h` : h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

/** Under a link panel whose way of voting is unticked: the links can be made, and every vote through them is refused. */
function MethodOff({ method, then }: { method: string; then: string }) {
  return (
    <p className="mt-3 border-l-[3px] border-flag-bar pl-3 text-13 text-ink-2">
      Tick <strong className="font-semibold text-ink">{method}</strong> under Who may vote: until you do, {then} every vote.
    </p>
  );
}

/** Where now falls in a window: its ends in ms, the share gone by (0 to 1), and whether it is still open. */
function windowNow(openAt: string, closeAt: string, now = Date.now()) {
  const o = Date.parse(openAt);
  const c = Date.parse(closeAt);
  return { o, c, now, gone: c > o ? Math.min(1, Math.max(0, (now - o) / (c - o))) : 1, open: now < c };
}

/** Fig. 01: the voting window as a line from open to close, the part gone by drawn solid, with where now falls. */
function WindowFigure({ openAt, closeAt }: { openAt: string; closeAt: string }) {
  const { o, c, now, gone, open } = windowNow(openAt, closeAt);
  return (
    <figure className="flex flex-col gap-2 border-t border-rule pt-4">
      <figcaption className="flex items-baseline justify-between gap-3 text-12 text-ink-2">
        <span className="label-mono text-ink">Fig. 01 — The window</span>
        <span className="tnum">{open ? `${stretch(c - now)} left` : `ran ${stretch(c - o)}`}</span>
      </figcaption>
      <div aria-hidden className="relative h-3">
        <span className="absolute inset-x-0 top-[5px] border-t border-dashed border-edge" />
        <span className="absolute top-[4px] left-0 h-[3px] bg-ink" style={{ width: `${gone * 100}%` }} />
        <span className="absolute top-0 left-0 h-3 w-px bg-ink" />
        <span className={`absolute top-0 right-0 h-3 w-px ${open ? "bg-edge" : "bg-ink"}`} />
        {open ? <span className="absolute top-0 h-3 w-[3px] -translate-x-1/2 bg-ink" style={{ left: `${gone * 100}%` }} /> : null}
      </div>
      <div className="flex justify-between gap-3 text-12 text-ink-2 tnum">
        <span>opened {formatUtc(openAt)}</span>
        <span className="text-right">{open ? "closes" : "closed"} {formatUtc(closeAt)}</span>
      </div>
    </figure>
  );
}

export default async function VotingPage({ params }: PageProps<"/organize/[event]/voting">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const v = guardPage(() => getVotingAdmin(actor, key));
  const { event } = v;
  const closed = v.state === "closed";
  // Publishing ends the vote: after it nothing here can change, even with no window set.
  const over = !closed && Boolean(event.resultsPublishedAt);
  // the open link's column shows while it is a way in, or once any of its ballots exist
  const withLink = v.settings.modes.includes("link") || Boolean(v.tally?.some((t) => t.openLink > 0));
  // the bars share one scale: counted votes, plus the open link's hatched tail when it is counted apart
  const top = v.tally ? Math.max(0, ...v.tally.map((t) => t.votes + (v.settings.countLink ? 0 : t.openLink))) : 0;
  // a row for every project with a vote of either kind; the rest share the "not picked" row
  const anyVotes = Boolean(v.tally?.some((t) => t.votes > 0 || t.openLink > 0));
  const zeros = v.tally ? v.tally.filter((t) => t.votes === 0 && t.openLink === 0) : [];
  // not set up, not open yet, or published with no vote: nothing to count or flag, so the setup leads
  const early = v.state === "not_set" || v.state === "upcoming";
  // nothing flagged: the duplicates panel needs one line, not a card beside turnout
  const quiet = v.suspected.length === 0;
  const final = closed || over;
  const setup = (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-3">
      {/* while it can change, the form takes two columns; once final, the three panels are equal summaries in one row */}
      <section aria-labelledby="settings-title" className={`rounded-sm border border-rule bg-surface p-5 ${final ? "" : "lg:col-span-2"}`}>
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
            {withLink ? (
              <>
                <dt className="text-ink-2">Open-link ballots</dt>
                <dd>{v.settings.countLink ? "Added to the result" : "Counted apart, changing no place"}</dd>
                <dt className="text-ink-2">New per network, per hour</dt>
                <dd className="tnum">{v.settings.linkPerAddress}</dd>
              </>
            ) : null}
          </dl>
        ) : over ? (
          <p className="text-14 text-ink-2">The results are published, so no window can be set.</p>
        ) : (
          <VotingSettingsForm
            eventSlug={event.slug}
            openAt={utcInput(event.votingOpenAt)}
            closeAt={utcInput(event.votingCloseAt)}
            modes={v.settings.modes}
            votesPerVoter={v.settings.votesPerVoter}
            countLink={v.settings.countLink}
            countRuleFixed={v.settings.countRuleFixed}
            linkPerAddress={v.settings.linkPerAddress}
          />
        )}
      </section>
      <div className={`flex flex-col gap-6 ${final ? "lg:col-span-2 lg:grid lg:grid-cols-2" : ""}`}>
        <section aria-labelledby="link-title" className="rounded-sm border border-rule bg-surface p-5">
          <h2 id="link-title" className="mb-3 text-17 font-semibold">
            Open voting link
          </h2>
          {closed || over ? <p className="text-14 text-ink-2">{closed ? "Voting has closed; the link only says so." : "No vote to link to."}</p> : <VotingLinkForm eventSlug={event.slug} active={v.settings.linkActive} />}
          {!final && v.linkTurnedAway.times > 0 ? (
            <p role="status" className="mt-3 border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-ink">
              A network ran out of new open-link ballots {v.linkTurnedAway.times === 1 ? "once" : `${v.linkTurnedAway.times} times`}, last at{" "}
              {formatUtc(v.linkTurnedAway.lastAt)}: its next voters waited. If your voters share one wifi, raise the {v.settings.linkPerAddress} per hour under
              Window and voters.
            </p>
          ) : null}
          {closed || over || v.settings.modes.includes("link") ? null : <MethodOff method="Anyone with the open link" then="the open link refuses" />}
        </section>
        <section aria-labelledby="list-title" className="rounded-sm border border-rule bg-surface p-5">
          <h2 id="list-title" className="mb-1 text-17 font-semibold">
            Voter list
          </h2>
          <p className="mb-3 text-14 text-ink-2">
            {v.listed.length} on the list, {v.listed.filter((l) => l.voted).length} voted.
            {closed || over ? "" : emailIsOn() ? " The portal mails each person their link as it is made." : " The portal sends no email: copy the links and send them yourself."}
          </p>
          {/* one cell per address on the list, filled once its ballot is in; a set-aside ballot is hollow and struck */}
          {v.listed.length ? (
            <div aria-hidden className="mb-4 flex flex-wrap gap-[3px]">
              {v.listed.map((l) => (
                <span
                  key={l.id}
                  title={`${l.email}: ${l.voided ? "set aside" : l.voted ? "voted" : "not yet"}`}
                  className={`h-3 w-2 ${l.voided ? "border border-ink-3 bg-[linear-gradient(to_top_right,transparent_45%,var(--ink-3)_45%_55%,transparent_55%)]" : l.voted ? "bg-ink" : "border border-edge"}`}
                />
              ))}
            </div>
          ) : null}
          {closed || over ? null : <VoterListForm eventSlug={event.slug} />}
          {closed || over || !v.listed.length ? null : <NewVoterLinkForm eventSlug={event.slug} />}
          {closed || over || v.settings.modes.includes("listed") ? null : <MethodOff method="People on a voter list" then="these links refuse" />}
        </section>
      </div>
    </div>
  );
  const count = v.tally ? (
    <section aria-labelledby="tally-title">
      <h2 id="tally-title" className="text-17 font-semibold">
        {v.state === "open" ? "The count so far" : "The count"}
      </h2>
      {v.state === "open" ? <p className="mt-1 text-14 text-ink-2">Live, and hidden from everyone but organizers until the window closes.</p> : null}
      <VoteRuleChanges changes={v.settings.ruleChanges} className="mt-3" />
      <VoteCountChanges changes={v.settings.countChanges} className="mt-3" />
      {withLink ? (
        <p className="mt-1 text-14 text-ink-2">
          Open-link ballots are hatched and counted apart, on the right of each row:{" "}
          {v.settings.countLink ? "they are included in the count." : "they change no place."}
        </p>
      ) : null}
      {!anyVotes ? (
        // Nothing counted yet: the ballot's field of faces, not a column of zeros.
        <div className="mt-3 flex flex-col gap-4 rounded-sm border border-rule bg-surface p-5">
          <p className="text-14">
            {closed ? (
              <>
                <strong className="font-semibold">No votes were cast.</strong>{" "}
                <span className="text-ink-2">The vote closed with all {v.tally.length} projects at 0.</span>
              </>
            ) : (
              <>
                <strong className="font-semibold">No votes yet.</strong>{" "}
                <span className="text-ink-2">All {v.tally.length} projects stand at 0; each gets a row and a bar here as ballots come in.</span>
              </>
            )}
          </p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(32px,1fr))] gap-1.5" aria-hidden>
            {v.tally.map((t) => (
              <span key={t.projectId} title={t.title}>
                <Face id={t.projectId} cols={32} rows={18} className="h-auto w-full" />
              </span>
            ))}
          </div>
          <details className="text-14">
            <summary className="cursor-pointer text-13 text-ink-2">Every project on the ballot</summary>
            <ol className="mt-2 gap-8 text-13 sm:columns-2 lg:columns-3">
              {v.tally.map((t) => (
                <li key={t.projectId} className="break-inside-avoid py-0.5">
                  <span className="font-medium">{t.title}</span> <span className="text-ink-2">· {t.teamName}</span>
                </li>
              ))}
            </ol>
          </details>
        </div>
      ) : (
        <ol className="mt-3 divide-y divide-rule rounded-sm border border-rule bg-surface">
          {v.tally.filter((t) => t.votes > 0 || t.openLink > 0).map((t) => (
            <li key={t.projectId} className={`grid items-center gap-x-3 px-4 py-2 text-14 ${withLink ? COUNT_ROW_LINK : COUNT_ROW}`}>
              <span className="text-ink-2 tnum">{t.place ?? "–"}</span>
              <Face id={t.projectId} cols={32} rows={18} className="h-[18px] w-8" />
              {/* phones: the team under the title, so neither is cut to "Amber Hours · ..." */}
              <span className="min-w-0 md:truncate">
                <span className="block truncate font-medium md:inline">{t.title}</span>
                <span className="block truncate text-12 text-ink-2 md:inline md:text-14">
                  <span className="max-md:hidden"> · </span>
                  {t.teamName}
                </span>
              </span>
              {/* the bar: votes against the leader's, so the gaps between places are seen, not read; the open
                  link's ballots hatched, as in the turnout bar: inside the bar when they count, a tail when they do not */}
              <span aria-hidden className="flex h-2.5 gap-[2px] max-md:hidden">
                {t.votes - (v.settings.countLink ? t.openLink : 0) > 0 ? (
                  <span className="bg-ink" style={{ width: `${((t.votes - (v.settings.countLink ? t.openLink : 0)) / top) * 100}%` }} />
                ) : null}
                {t.openLink > 0 ? <span className={CHANNEL.link} style={{ width: `${(t.openLink / top) * 100}%` }} /> : null}
              </span>
              <span className="text-right font-semibold tnum">{t.votes}</span>
              {withLink ? (
                <span className="inline-flex items-center justify-end gap-1.5 font-mono text-12 whitespace-nowrap text-ink-2 tnum">
                  {t.openLink > 0 ? (
                    <>
                      <span aria-hidden className={`inline-block size-2.5 shrink-0 ${CHANNEL.link}`} />
                      {`${v.settings.countLink ? "incl. " : "+"}${t.openLink}`}
                      <span className="max-md:sr-only"> open link</span>
                    </>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
          {/* the projects nobody picked share one place: one row with their faces, the names on request */}
          {zeros.length ? (
            <li className="grid grid-cols-[28px_minmax(0,1fr)_40px] items-start gap-x-3 px-4 py-3 text-14">
              <span className="text-ink-2 tnum">–</span>
              <details>
                <summary className="cursor-pointer text-ink-2">
                  {zeros.length === 1 ? `${zeros[0]!.title}, not picked yet` : `${zeros.length} projects not picked${closed ? "" : " yet"}`}
                </summary>
                <ol className="mt-2 gap-8 text-13 sm:columns-2 lg:columns-3">
                  {zeros.map((t) => (
                    <li key={t.projectId} className="break-inside-avoid py-0.5">
                      <span className="font-medium">{t.title}</span> <span className="text-ink-2">· {t.teamName}</span>
                    </li>
                  ))}
                </ol>
              </details>
              <span className="text-right font-semibold tnum">0</span>
              <span aria-hidden className="col-start-2 mt-2 flex flex-wrap gap-1">
                {zeros.map((t) => (
                  <Face key={t.projectId} id={t.projectId} cols={32} rows={18} className="h-[18px] w-8" />
                ))}
              </span>
            </li>
          ) : null}
        </ol>
      )}
    </section>
  ) : null;
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
            {over
              ? "No community vote: the results are published, and a vote now would run with the ranking in view."
              : v.state === "not_set"
              ? "Not set up. Choose a window and who may vote."
              : v.state === "upcoming"
                ? `Opens ${formatUtc(event.votingOpenAt)}, closes ${formatUtc(event.votingCloseAt)}.`
                : v.state === "open"
                  ? `Open until ${formatUtc(event.votingCloseAt)}. The count below is live and only organizers see it; everyone else sees it when the window closes.`
                  : `Closed ${formatUtc(event.votingCloseAt)}${event.votingCloseAt === event.resultsPublishedAt ? ", when the results were published" : ""}. The counts are public on the results page, and final: the window cannot move and no ballot can be set aside or restored.`}
          </p>
        </header>

        {/* Before the window opens nothing can be counted or flagged: the setup comes first, alone. Once it has
            closed the count is the result, final and public, so it leads and turnout follows as its context. */}
        {early ? setup : null}
        {closed ? count : null}

        {early ? null : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-3">
          {/* With nothing flagged, turnout runs the full width as one strip (number, channels, window) and the
              duplicates panel shrinks to a line, instead of a two-column card holding "None so far." */}
          <section
            aria-labelledby="turnout-title"
            className={`flex flex-col rounded-sm border border-rule bg-surface p-5 ${quiet ? "lg:col-span-3 lg:grid lg:grid-cols-3 lg:gap-x-10" : ""}`}
          >
            <div>
            <h2 id="turnout-title" className="text-15 font-semibold">
              Turnout
            </h2>
            <p className="mt-3 flex items-baseline gap-2">
              <span className="text-38 leading-none font-semibold tnum">{v.turnout.ballots}</span>
              <span className="text-13 text-ink-2">ballots counted{v.turnout.voided ? ` · ${v.turnout.voided} set aside` : ""}</span>
            </p>
            </div>
            <div className={quiet ? "lg:pt-1" : ""}>
            {/* the ballots by the way they came in: one bar, split by channel; dashed and empty before the first */}
            <div className={`mt-4 flex h-3 w-full gap-[2px] ${quiet ? "lg:mt-0" : ""} ${v.turnout.ballots ? "" : "border border-dashed border-edge"}`} aria-hidden>
              {v.turnout.byKind
                .filter((k) => k.ballots > 0)
                .map((k) => (
                  <span key={k.kind} className={CHANNEL[k.kind]} style={{ flexGrow: k.ballots, flexBasis: 0 }} />
                ))}
            </div>
            <ul className="mt-3 flex flex-col gap-1 text-14 text-ink-2">
              {v.turnout.byKind.map((k) => (
                <li key={k.kind} className="flex items-center gap-2">
                  <span aria-hidden className={`inline-block size-2.5 ${CHANNEL[k.kind]}`} />
                  <span className="flex-1">{KIND[k.kind]}</span>
                  <span className="text-ink tnum">{k.ballots}</span>
                </li>
              ))}
            </ul>
            </div>
            {event.votingOpenAt && event.votingCloseAt ? (
              <div className={quiet ? "mt-5 lg:mt-0 lg:pt-1 [&>figure]:lg:border-t-0 [&>figure]:lg:pt-0" : "mt-5 lg:mt-auto lg:pt-5"}>
                <WindowFigure openAt={event.votingOpenAt} closeAt={event.votingCloseAt} />
              </div>
            ) : null}
          </section>
          <section aria-labelledby="dup-title" className={`rounded-sm border border-rule bg-surface lg:col-span-2 ${quiet ? "px-5 py-4 lg:col-span-3" : "p-5"}`}>
            {quiet ? (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 id="dup-title" className="text-15 font-semibold">
                  Suspected duplicates
                </h2>
                <p className="text-14 text-ink-2">
                  {closed ? "None: no two ballots came from the same network address and browser." : "None so far. Ballots from the same network address and browser show here, for you to look at."}
                </p>
              </div>
            ) : (
              <>
            <h2 id="dup-title" className="text-15 font-semibold">
              Suspected duplicates
            </h2>
            <p className="mt-1 text-14 text-ink-2">
              Ballots from the same network address and browser.{" "}
              {closed ? "Voting has closed, so they stay as they are." : "Look at them; set one aside only with a reason."}
            </p>
              </>
            )}
            {quiet ? null : (
              <ul className="mt-3 flex flex-col gap-3">
                {v.suspected.map((g) => (
                  // orange means "needs you": once voting has closed nothing here can be acted on, so the bar goes neutral
                  <li key={g.key} className={`rounded-sm border border-rule border-l-[3px] p-3 ${closed ? "border-l-edge" : "border-l-flag-bar"}`}>
                    <p className="text-13 text-ink-2">
                      {g.voters.length} ballots, same address and browser <span className="font-mono">#{g.key}</span>
                    </p>
                    <ul className="mt-2 flex flex-col gap-2">
                      {g.voters.map((voter) => (
                        <li key={voter.id} className="flex flex-wrap items-center justify-between gap-2 text-14">
                          {/* named as the audit log names the voter ("Link voter 4kdtgr"), so a row can be found there; the full id on hover */}
                          <span className={voter.voided ? "text-ink-3 line-through" : ""} title={voter.id}>
                            <span className="font-medium">{VOTER[voter.kind] ?? "Voter"}</span> <span className="font-mono text-12">{voter.id.slice(-6)}</span>
                            <span className={voter.voided ? "" : "text-ink-2"}>
                              {" "}
                              · {voter.picks} {voter.picks === 1 ? "pick" : "picks"} · from {formatUtc(voter.createdAt)}
                            </span>
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
        )}

        {closed ? null : count}

        {early ? null : setup}
      </div>
    </WorkShell>
  );
}
