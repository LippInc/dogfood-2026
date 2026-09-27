import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { AuditTable, ChainStatus } from "@/components/audit-table";
import { WorkShell } from "@/components/shell/work-shell";
import { plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getPortalLog } from "@/server/dal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Portal log" };

/** The entries no event owns, for the portal's administrators. */
export default async function PortalLogPage() {
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { lines, total, chain } = guardPage(() => getPortalLog(actor));
  return (
    <WorkShell eventName="Dogfood portal" eventHref="/organize" crumb="Portal log" person={actor.name} role="Administrator">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
        <header>
          <h1 className="text-24 font-semibold">Portal log</h1>
          <p className="mt-2 max-w-[760px] text-15 text-ink-2">
            The entries no event owns: accounts made, sign-ins, API tokens, the signing key, demo mode, and requests refused outside any event.
            Each event&rsquo;s own entries are on its Audit log tab. Both are parts of one hash chain.
          </p>
        </header>
        <ChainStatus chain={chain} />
        <AuditTable lines={lines} />
        <p className="text-13 text-ink-2">
          Showing the latest {lines.length} of {plural(total, "entry", "entries")} that no event owns; <code className="font-mono text-12">GET /api/audit</code> gives the same as JSON.
        </p>
      </div>
    </WorkShell>
  );
}
