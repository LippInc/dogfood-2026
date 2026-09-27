import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { Face } from "@/components/face";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { formatUtc, isPast } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getSubmissions } from "@/server/dal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Submissions" };

export default async function SubmissionsPage({ params }: PageProps<"/organize/[event]/submissions">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, rows, submitted, drafts } = guardPage(() => getSubmissions(actor, key));
  return (
    <WorkShell eventName={event.name} eventHref={`/organize/${event.slug}`} tabs={organizerTabs(event.slug, "Submissions")} person={actor.name} role="Organizer">
      <div className="flex flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-24 font-semibold">Submissions</h1>
            <p className="mt-2 text-15 text-ink-2 tnum">
              {submitted} submitted · {drafts} {drafts === 1 ? "draft" : "drafts"} · submissions {isPast(event.submissionsCloseAt) ? "closed" : "close"}{" "}
              {formatUtc(event.submissionsCloseAt)}
            </p>
          </div>
          <a
            href={`/api/events/${event.id}/export/projects.csv`}
            className="inline-flex h-9 items-center rounded-sm border border-edge px-3 text-14 font-medium hover:bg-raised"
          >
            Download projects.csv
          </a>
        </header>
        {rows.length === 0 ? (
          <p className="rounded-sm border border-rule bg-surface p-6 text-15 text-ink-2">
            No projects yet. Teams appear here from their first saved draft; the public gallery shows only submitted ones.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-rule bg-surface">
            <table className="w-full text-14">
              <thead>
                <tr className="border-b border-rule text-left text-13 text-ink-2">
                  <th className="px-3 py-2 font-medium" colSpan={2}>
                    Project
                  </th>
                  <th className="px-3 py-2 font-medium">Track</th>
                  <th className="px-3 py-2 font-medium">Team</th>
                  <th className="px-3 py-2 font-medium">Submitted</th>
                  <th className="px-3 py-2 text-right font-medium">Reviews</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-rule align-top last:border-b-0">
                    <td className="w-12 py-2 pl-3">
                      <Face id={r.id} cols={32} rows={18} className="mt-0.5 block h-[18px] w-8" />
                    </td>
                    <td className="px-3 py-2">
                      {r.status === "submitted" ? (
                        <Link href={`/events/${event.slug}/projects/${r.id}`} className="font-medium hover:underline">
                          {r.title}
                        </Link>
                      ) : (
                        <span className="font-medium">{r.title || "Untitled draft"}</span>
                      )}{" "}
                      <span className="font-mono text-12 text-ink-3">{r.id}</span>
                      {r.status === "draft" ? <span className="ml-2 text-12 text-ink-2">draft</span> : null}
                      {r.duplicateOf ? (
                        <span className="ml-2 text-12 text-ink-2">merged into {r.duplicateOf}</span>
                      ) : r.mergedIn.length ? (
                        <span className="ml-2 text-12 text-ink-2">{r.mergedIn.join(", ")} merged into this</span>
                      ) : r.suspectedDuplicate ? (
                        <Link href={`/organize/${event.slug}`} className="ml-2 text-12 text-flag underline underline-offset-2">
                          suspected duplicate
                        </Link>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-ink-2">{r.trackName}</td>
                    <td className="px-3 py-2">
                      {r.teamName} <span className="text-13 text-ink-2">· {r.members}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-12 whitespace-nowrap text-ink-2">{r.submittedAt ? formatUtc(r.submittedAt).replace(" UTC", "") : "–"}</td>
                    <td className="px-3 py-2 text-right tnum">{r.reviewsAssigned ? `${r.reviewsDone} of ${r.reviewsAssigned}` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </WorkShell>
  );
}
