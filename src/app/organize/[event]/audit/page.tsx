import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { formatUtc, plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getAuditLog } from "@/server/dal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage({ params }: PageProps<"/organize/[event]/audit">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, lines, total, chain } = guardPage(() => getAuditLog(actor, key));
  return (
    <WorkShell eventName={event.name} eventHref={`/organize/${event.slug}`} tabs={organizerTabs(event.slug, "Audit log")} person={actor.name} role="Organizer">
      <div className="flex flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-24 font-semibold">Audit log</h1>
            <p className="mt-2 max-w-[760px] text-15 text-ink-2">
              Every change and every refused request, in the same transaction as the change itself. Rows cannot be edited or deleted through the app: the
              database refuses it. Each row carries the hash of the one before, so a rewritten history no longer matches a head hash you kept.
            </p>
          </div>
          <a
            href={`/api/events/${event.id}/export/audit.csv`}
            className="inline-flex h-9 items-center rounded-sm border border-edge px-3 text-14 font-medium hover:bg-raised"
          >
            Download audit.csv
          </a>
        </header>
        <p
          className={`rounded-sm border px-4 py-3 text-14 ${chain.ok ? "border-rule bg-surface" : "border-flag-bar bg-flag-bg text-flag"}`}
          role="status"
        >
          {chain.ok ? (
            <>
              Chain verified from the first row: {plural(chain.rows, "row")} in the whole log. Head hash <span className="font-mono text-13 break-all">{chain.head}</span>
            </>
          ) : (
            <>The chain is broken at row {chain.brokenAtId}: a row was changed outside the app. Treat everything after it as unverified.</>
          )}
        </p>
        <div className="overflow-x-auto rounded-sm border border-rule bg-surface">
          <table className="w-full text-14">
            <thead>
              <tr className="border-b border-rule text-left text-13 text-ink-2">
                <th className="px-3 py-2 font-medium">When (UTC)</th>
                <th className="px-3 py-2 font-medium">What happened</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Row</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className={`border-b border-rule align-top last:border-b-0 ${l.action === "authz.refused" ? "text-ink-2" : ""}`}>
                  <td className="px-3 py-2 font-mono text-12 whitespace-nowrap text-ink-2">{formatUtc(l.at).replace(" UTC", "")}</td>
                  <td className="px-3 py-2 leading-5">
                    {l.parts.map((p, i) =>
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
                  </td>
                  <td className="px-3 py-2 font-mono text-12 whitespace-nowrap text-ink-2">{l.action}</td>
                  <td className="px-3 py-2 font-mono text-12 text-ink-3" title={l.hash}>
                    #{l.id} {l.hash.slice(0, 8)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-13 text-ink-2">
          Showing the latest {lines.length} of {plural(total, "entry", "entries")} for this event; audit.csv has all of them, oldest first, each with its own hash and the one before.
        </p>
      </div>
    </WorkShell>
  );
}
