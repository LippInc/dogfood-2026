import { formatUtc, plural } from "@/lib/format";
import type { AuditLine } from "@/server/dal";

type Chain = { ok: true; rows: number; head: string } | { ok: false; brokenAtId: number };

/** Whether the whole log's hash chain holds, and its head hash when it does. */
export function ChainStatus({ chain }: { chain: Chain }) {
  return (
    <p className={`rounded-sm border px-4 py-3 text-14 ${chain.ok ? "border-rule bg-surface" : "border-flag-bar bg-flag-bg text-flag"}`} role="status">
      {chain.ok ? (
        <>
          Chain verified from the first row: {plural(chain.rows, "row")} in the whole log. Head hash <span className="font-mono text-13 break-all">{chain.head}</span>
        </>
      ) : (
        <>The chain is broken at row {chain.brokenAtId}: a row was changed outside the app. Treat everything after it as unverified.</>
      )}
    </p>
  );
}

/** The log's rows, newest first: when, the sentence, the action's name, and the row's number and hash. */
export function AuditTable({ lines }: { lines: AuditLine[] }) {
  return (
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
              <td className="min-w-48 px-3 py-2 leading-5 wrap-anywhere">
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
  );
}
