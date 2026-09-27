import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { AuditTable, ChainStatus } from "@/components/audit-table";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getAuditLog } from "@/server/dal";
import { exportHref } from "@/lib/export-href";

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
              Every change, and every request refused to someone signed in or holding a voting link, in the same transaction as the change itself.
              Rows cannot be edited or deleted through the app: the database refuses it. Each row carries the hash of the one before, so a rewritten
              history no longer matches a head hash you kept.
            </p>
          </div>
          <a
            href={exportHref(event.id, "audit.csv")}
            className="inline-flex h-9 items-center rounded-sm border border-edge px-3 text-14 font-medium hover:bg-raised"
          >
            Download audit.csv
          </a>
        </header>
        <ChainStatus chain={chain} />
        <AuditTable lines={lines} />
        <p className="text-13 text-ink-2">
          Showing the latest {lines.length} of {plural(total, "entry", "entries")} for this event; audit.csv has all of them, oldest first, each with its own hash and the one before.
        </p>
      </div>
    </WorkShell>
  );
}
