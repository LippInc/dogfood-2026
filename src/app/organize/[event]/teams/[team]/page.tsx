import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { formatUtc, isPast, plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getTeamForOrganizer, type OrganizerTeamView } from "@/server/dal";
import { RenameTeamForm } from "./team-forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Team" };

function Sentence({ parts }: { parts: OrganizerTeamView["history"][number]["parts"] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.mono ? (
          <span key={i} className="font-mono text-12 text-ink-2">
            {p.text}
          </span>
        ) : p.strong ? (
          <strong key={i} className="font-semibold">
            {p.text}
          </strong>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
      .
    </>
  );
}

/** One team as its organizers manage it: who is on it, its name, and every change to it with the reason given. */
export default async function OrganizerTeamPage({ params }: PageProps<"/organize/[event]/teams/[team]">) {
  const { event: key, team: teamId } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const view = guardPage(() => getTeamForOrganizer(actor, key, teamId));
  const { event, team, members, project, canChange, history } = view;
  const closed = isPast(event.submissionsCloseAt);
  const back = `/organize/${event.slug}/submissions`;
  return (
    <WorkShell eventName={event.name} eventHref={`/organize/${event.slug}`} tabs={organizerTabs(event.slug, "Submissions")} person={actor.name} role="Organizer">
      <div className="flex max-w-[880px] flex-col gap-10">
        <header>
          <Link href={back} className="text-13 text-ink-2 underline decoration-edge underline-offset-4 hover:text-ink hover:decoration-ink">
            Submissions
          </Link>
          <p className="label-mono mt-4 text-ink-3">Team · {team.id}</p>
          <h1 className="mt-1 text-24 font-semibold wrap-anywhere">{team.name}</h1>
          <p className="mt-2 text-15 text-ink-2">
            {plural(members.length, "member")} · started {formatUtc(team.createdAt)} ·{" "}
            {project ? (
              project.status === "submitted" ? (
                <>
                  project{" "}
                  <Link href={`/events/${event.slug}/projects/${project.id}`} className="font-medium text-ink underline underline-offset-4">
                    {project.title}
                  </Link>
                </>
              ) : (
                <>a draft, {project.title || "untitled"}</>
              )
            ) : (
              "no project yet"
            )}
          </p>
          <p className="mt-3 max-w-[640px] text-14 text-ink-2">
            {event.resultsPublishedAt
              ? "Results are published, so this team is final: its name and members stay as they were judged and certified."
              : closed
                ? "Submissions are closed, so the team can no longer change itself. Until results are published you can, with a reason; certificates go to whoever is on the team then."
                : "While submissions are open the team manages itself: members rename it and join by its invite link, and its captain takes members off. You can step in, with a reason."}
          </p>
        </header>

        <section aria-labelledby="members-title" className="flex flex-col gap-3">
          <h2 id="members-title" className="text-20 font-semibold">
            Members
          </h2>
          <div className="rounded-sm border border-rule bg-surface">
            <table className="w-full text-14 max-md:block">
              <thead className="max-md:hidden">
                <tr className="border-b border-rule text-left text-13 text-ink-2">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Joined, UTC</th>
                </tr>
              </thead>
              <tbody className="max-md:block">
                {members.map((m) => (
                  <tr key={m.userId} className="border-b border-rule align-top last:border-b-0 max-md:flex max-md:flex-col max-md:gap-0.5 max-md:px-4 max-md:py-3">
                    <td className="px-3 py-2.5 font-medium wrap-anywhere max-md:p-0">{m.name}</td>
                    <td className="px-3 py-2.5 font-mono text-12 text-ink-2 wrap-anywhere max-md:p-0">{m.email}</td>
                    <td className="px-3 py-2.5 text-ink-2 max-md:p-0 max-md:text-13">{m.role}</td>
                    <td className="px-3 py-2.5 font-mono text-12 whitespace-nowrap text-ink-2 max-md:p-0">{formatUtc(m.joinedAt).replace(" UTC", "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {canChange ? (
          <section aria-labelledby="rename-title" className="flex max-w-[560px] flex-col gap-3">
            <h2 id="rename-title" className="text-20 font-semibold">
              Rename
            </h2>
            <RenameTeamForm teamId={team.id} eventSlug={event.slug} name={team.name} />
          </section>
        ) : null}

        <section aria-labelledby="history-title" className="flex flex-col gap-3">
          <h2 id="history-title" className="text-20 font-semibold">
            What happened to this team
          </h2>
          {history.length ? (
            <ol className="border-t border-rule">
              {history.map((l) => (
                <li key={l.id} className="grid gap-x-5 gap-y-0.5 border-b border-rule py-2.5 md:grid-cols-[150px_minmax(0,1fr)]">
                  <span className="font-mono text-12 whitespace-nowrap text-ink-2">{formatUtc(l.at).replace(" UTC", "")}</span>
                  <span className="text-14 leading-5 wrap-anywhere">
                    <Sentence parts={l.parts} />
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-15 text-ink-2">Nothing in the audit log yet: this team came in with the event&apos;s data.</p>
          )}
          <Link href={`/organize/${event.slug}/audit`} className="self-start text-13 text-ink-2 underline decoration-edge underline-offset-4 hover:text-ink">
            The whole audit log
          </Link>
        </section>
      </div>
    </WorkShell>
  );
}
