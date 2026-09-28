import { formatUtc } from "@/lib/format";
import type { OutboxView } from "@/server/dal";

// What the portal mailed, in the webhook deliveries' own parts (Integrations page, HookCard): a count
// line, the newest failure called out, and the last messages in a table that stacks on a phone. Each
// message's text opens under its row, as it was sent but with the link blanked.

const KIND: Record<string, string> = {
  judge_invite: "Judge invitation",
  voter_link: "Voting link",
  claim_link: "Account link",
  password_reset: "Password reset",
  judge_reminder: "Reminder",
  admin_setup: "Setup link",
};

export function OutboxTable({ mail }: { mail: OutboxView[] }) {
  if (!mail.length) return null;
  const sent = mail.filter((m) => m.status === "sent").length;
  const failed = mail.filter((m) => m.status === "failed").length;
  const newest = mail[0]!;
  const troubled = newest.status === "failed";
  return (
    <div className="flex flex-col gap-3">
      <p className="text-13 text-ink-2 tnum">
        <span className="text-ink">{sent}</span> sent · <span className={failed ? "font-medium text-flag" : "text-ink"}>{failed}</span> failed
        {mail.length === 100 ? <span className="text-ink-3"> · the last 100</span> : null}
      </p>
      {troubled && newest.error ? (
        <p className="flex max-w-[760px] flex-wrap items-baseline gap-x-3 gap-y-0.5 border-l-2 border-flag-bar pl-3 text-14 text-ink">
          <span className="label-mono text-flag">Last error</span>
          <span>{newest.error}</span>
        </p>
      ) : null}
      <details open={troubled || undefined} className="border-t border-rule pt-3">
        <summary className="cursor-pointer text-13 font-medium text-ink-2 hover:text-ink">Last messages, newest first</summary>
        <table className="mt-2 w-full text-13 max-sm:block">
          <thead className="text-left text-12 text-ink-2 max-sm:hidden">
            <tr>
              <th className="py-1.5 pr-4 font-medium">When (UTC)</th>
              <th className="py-1.5 pr-4 font-medium">To</th>
              <th className="py-1.5 pr-4 font-medium">What</th>
              <th className="py-1.5 font-medium">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule max-sm:block">
            {mail.map((m) => (
              <MailRow key={m.id} m={m} />
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function MailRow({ m }: { m: OutboxView }) {
  const td = "py-2 pr-4 align-top max-sm:p-0";
  return (
    <tr className="max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:gap-x-3 max-sm:gap-y-1 max-sm:py-3">
      <td className={`${td} font-mono text-12 whitespace-nowrap text-ink-2`}>{formatUtc(m.createdAt).replace(" UTC", "")}</td>
      <td className={`${td} break-all max-sm:col-span-2`}>{m.toEmail}</td>
      <td className={`${td} max-sm:col-span-2`}>
        <details>
          <summary className="cursor-pointer">
            {KIND[m.kind] ?? m.kind}: {m.subject}
          </summary>
          <pre className="mt-1.5 max-w-[640px] font-mono text-12 whitespace-pre-wrap text-ink-2">{m.body}</pre>
        </details>
      </td>
      <td className="py-2 align-top max-sm:col-start-2 max-sm:row-start-1 max-sm:justify-self-end max-sm:p-0">
        {m.status === "sent" ? <span className="text-ok">Sent</span> : <span className="font-medium text-flag">Failed</span>}
        {m.status === "failed" && m.error ? <span className="mt-0.5 block text-12 text-ink-2">{m.error}</span> : null}
      </td>
    </tr>
  );
}
