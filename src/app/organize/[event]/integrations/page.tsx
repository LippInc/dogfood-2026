import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { Delivery, DeliveryTall } from "@/components/figures/delivery";
import { LiveRefresh } from "@/components/live-refresh";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { Badge } from "@/components/ui/badge";
import { formatUtc } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { countBeyondReach, countWithoutPassword, currentActor, emailIsOn, EXPORT_FILES, listDeliveries, listOutbox, listWebhooks, publicUrl, ValidationError, type OutboxPage } from "@/server/dal";
import { CopyButton } from "../judges/forms";
import { retry, sendTest, toggleWebhook } from "./actions";
import { AddWebhookForm, ClaimLinksForm, RotateSecretForm } from "./forms";
import { exportHref } from "@/lib/export-href";
import { OutboxTable } from "@/components/outbox-table";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Integrations" };

const small = "inline-flex h-8 items-center rounded-sm border border-edge px-3 text-13 font-medium hover:bg-raised";
/** The retry schedule, in seconds: the same as RETRY_DELAYS_S in src/server/webhooks.ts, which pages cannot import (only the DAL). */
const RETRY_DELAYS_S = [10, 60, 300, 1800, 7200] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
/** The most attempts one delivery keeps, retries by hand included: ATTEMPTS_CAP in src/server/webhooks.ts. */
const ATTEMPTS_CAP = 20;
/** What each export holds, in the overview's words; a file added to the DAL later shows with no line until it is named here. */
const EXPORT_HOLDS: Record<string, string> = {
  "scores.csv": "every raw score",
  "projects.csv": "the projects",
  "normalized.csv": "the normalized ranking",
  "audit.csv": "the audit log",
  "comparisons.csv": "every pairwise answer",
  "event.json": "the whole event as a record, with settings and decisions",
  "fixtures.json": "moves the event to another portal",
};

export default async function IntegrationsPage({ params, searchParams }: PageProps<"/organize/[event]/integrations">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, webhooks } = guardPage(() => listWebhooks(actor, key));
  const deliveries = Object.fromEntries(webhooks.map((w) => [w.id, listDeliveries(actor, key, w.id).slice(0, 10)]));
  const origin = publicUrl();
  const snippet = `<script src="${origin}/embed.js" data-event="${event.slug}" async></script>`;
  const waiting = countWithoutPassword(actor, key);
  const elsewhere = countBeyondReach(actor, key);
  const on = webhooks.filter((w) => w.enabled).length;
  // ?outbox=<id>: an older page of the outbox, starting after that message; a stale or made-up one shows the newest
  const before = (await searchParams).outbox;
  let showingOlder = typeof before === "string" && before !== "";
  let mail: OutboxPage;
  try {
    mail = listOutbox(actor, key, { before: showingOlder ? (before as string) : null });
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    mail = listOutbox(actor, key);
    showingOlder = false;
  }
  const mailOn = emailIsOn();
  const mailFailed = mail.counts.failed;
  const totals = webhooks.reduce((t, w) => ({ delivered: t.delivered + w.counts.delivered, failed: t.failed + w.counts.failed }), { delivered: 0, failed: 0 });

  return (
    <WorkShell
      eventName={event.name}
      eventHref={`/organize/${event.slug}`}
      tabs={organizerTabs(event.slug, "Integrations")}
      tools={<LiveRefresh />}
      person={actor.name}
      role="Organizer"
    >
      <div className="flex max-w-[1100px] flex-col gap-12">
        <header>
          <h1 className="text-24 font-semibold">Integrations</h1>
          <p className="mt-2 max-w-[760px] text-15 text-ink-2">
            Connect the event to the rest of your tools: the same actions as this interface over JSON, a message to your server whenever something
            happens, and the gallery on your own site.
          </p>
          <Contents
            entries={[
              { id: "api-title", title: "API", holds: "JSON routes, OpenAPI", mark: "set" },
              {
                id: "hooks-title",
                title: "Webhooks",
                holds: webhooks.length
                  ? [`${on} of ${webhooks.length} on`, totals.failed ? `${totals.failed} failed` : `${totals.delivered} delivered`].join(" · ")
                  : "none yet",
                mark: totals.failed ? "flag" : on ? "set" : "open",
              },
              {
                id: "mail-title",
                title: "Email",
                holds: mail.counts.total
                  ? [`${mail.counts.sent} sent`, mailFailed ? `${mailFailed} failed` : null, mail.counts.unknown ? `${mail.counts.unknown} may have arrived` : null, mail.counts.sending ? `${mail.counts.sending} sending` : null].filter(Boolean).join(" · ")
                  : mailOn
                    ? "on, nothing mailed yet"
                    : "off",
                mark: !showingOlder && mail.messages[0]?.status === "failed" ? "flag" : mailOn ? "set" : "open",
              },
              {
                id: "io-title",
                title: "Import and export",
                holds: `${EXPORT_FILES.length} files · ${waiting ? `${waiting} without a password` : "every password set"}`,
                mark: "set",
              },
              { id: "share-title", title: "On your site", holds: "one script tag", mark: "set" },
            ]}
          />
        </header>

        <section aria-labelledby="api-title" className="flex flex-col gap-3">
          <h2 id="api-title" className="scroll-mt-6 text-20 font-semibold">
            <SectionNo n={1} />
            API
          </h2>
          <p className="max-w-[760px] text-15 text-ink-2">
            Every action here is also a JSON route, with the same permission checks. Scripts send an API token as{" "}
            <code className="font-mono text-13">Authorization: Bearer &lt;token&gt;</code>; it acts as the person who made it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/api-docs" className={small}>
              API reference
            </Link>
            <a href="/api/openapi.json" className={small}>
              OpenAPI document
            </a>
            <Link href="/account/tokens" className={small}>
              Your API tokens
            </Link>
          </div>
        </section>

        <section aria-labelledby="hooks-title" className="flex flex-col gap-5">
          <div>
            <h2 id="hooks-title" className="scroll-mt-6 text-20 font-semibold">
              <SectionNo n={2} />
            Webhooks
            </h2>
            <p className="mt-1 max-w-[760px] text-15 text-ink-2">
              Each audited action (a submission, a review, a vote, a published result) is POSTed to your URL as JSON as it happens.
            </p>
          </div>

          {webhooks.length ? (
            <ul className="flex flex-col gap-4">
              {webhooks.map((w) => (
                <HookCard key={w.id} slug={event.slug} hook={w} deliveries={deliveries[w.id]!} />
              ))}
            </ul>
          ) : (
            <p className="text-14 text-ink-2">No webhooks yet. One added below receives every audited action from then on; nothing earlier is sent.</p>
          )}

          <figure className="flex flex-col gap-3 border-t-2 border-ink pt-3">
            <figcaption className="label-mono text-ink">Fig. 01 — One delivery</figcaption>
            <div className="md:hidden">
              <DeliveryTall delays={RETRY_DELAYS_S} />
            </div>
            <div className="overflow-x-auto max-md:hidden">
              <div className="min-w-[680px]">
                <Delivery delays={RETRY_DELAYS_S} />
              </div>
            </div>
            <dl className="mt-1 grid border-t border-rule text-13 sm:grid-cols-[9.5rem_1fr]">
              <dt className="pt-2.5 font-medium text-ink sm:border-b sm:border-rule sm:py-2.5 sm:pr-4">Signature</dt>
              <dd className="border-b border-rule pb-2.5 text-ink-2 sm:py-2.5">
                <code className="font-mono text-12 text-ink">Dogfood-Signature: t=&lt;time&gt;,v1=&lt;HMAC-SHA256&gt;</code> over{" "}
                <code className="font-mono text-12 text-ink">&lt;time&gt;.&lt;body&gt;</code>, keyed with the webhook&rsquo;s secret
              </dd>
              <dt className="pt-2.5 font-medium text-ink sm:border-b sm:border-rule sm:py-2.5 sm:pr-4">Checking it</dt>
              <dd className="border-b border-rule pb-2.5 text-ink-2 sm:py-2.5">
                compute the signature again and compare in constant time; refuse a delivery whose{" "}
                <code className="font-mono text-12 text-ink">&lt;time&gt;</code> is more than five minutes from your clock, so a copied one
                cannot be replayed later. A retry carries the same <code className="font-mono text-12 text-ink">Dogfood-Delivery</code> id: act on
                each id once
              </dd>
              <dt className="pt-2.5 font-medium text-ink sm:border-b sm:border-rule sm:py-2.5 sm:pr-4">Left out</dt>
              <dd className="border-b border-rule pb-2.5 text-ink-2 sm:py-2.5">
                a ballot&rsquo;s picks, a judge&rsquo;s scores and a judge&rsquo;s pairwise answers: the delivery says who acted and when, and the
                values stay here
              </dd>
            </dl>
          </figure>

          <div className="rounded-sm border border-rule p-5">
            <h3 className="mb-4 text-15 font-semibold">Add a webhook</h3>
            <AddWebhookForm eventSlug={event.slug} />
          </div>
        </section>

        <section aria-labelledby="mail-title" className="flex flex-col gap-4">
          <div>
            <h2 id="mail-title" className="scroll-mt-6 text-20 font-semibold">
              <SectionNo n={3} />
              Email
            </h2>
            <p className="mt-1 max-w-[760px] text-15 text-ink-2">
              {mailOn
                ? "Judge invitations with an address, voter links and account links are mailed the moment they are made. The copy kept here has its link blanked, so a message cannot be sent again: make a new link instead."
                : "Email is off: each link shows once on the screen that makes it, to copy and send yourself. With SMTP_URL and MAIL_FROM set, the portal mails them as they are made."}
            </p>
          </div>
          <OutboxTable page={mail} older={showingOlder} href={(b) => (b ? `?outbox=${encodeURIComponent(b)}#mail-title` : "?#mail-title")} />
        </section>

        <section aria-labelledby="io-title" className="flex flex-col gap-4">
          <div>
            <h2 id="io-title" className="scroll-mt-6 text-20 font-semibold">
              <SectionNo n={4} />
            Import and export
            </h2>
            <p className="mt-1 max-w-[760px] text-15 text-ink-2">
              Take everything out at any stage. <code className="font-mono text-13">fixtures.json</code> is the file that moves this event to
              another portal: the organizers&rsquo; fixture format, with your rubric (labels, prompts, weights), your questions to teams and their
              answers, and each project&rsquo;s description and links added. An administrator imports it there (Your events, Import an event) and
              gets the same projects, judges, scores and rubric, and the same ranking as before any decision.{" "}
              <code className="font-mono text-13">event.json</code> is the whole record, to keep: settings and your decisions (a merge, a
              reinstated judge) are only in it and do not move.
            </p>
          </div>
          <ul aria-label="Exports" className="grid border-t border-rule md:grid-cols-2 md:gap-x-10">
            {EXPORT_FILES.map((f) => (
              <li key={f} className="border-b border-rule">
                <a href={exportHref(event.id, f)} className="group grid grid-cols-[9.5rem_1fr] items-baseline gap-4 py-2.5 hover:bg-raised">
                  <span className="font-mono text-13 text-ink underline decoration-edge underline-offset-4 group-hover:decoration-ink">{f}</span>
                  <span className="text-13 text-ink-2">{f === "normalized.csv" && event.resultsPublishedAt ? "the published ranking, read from its stored run" : (EXPORT_HOLDS[f] ?? "")}</span>
                </a>
              </li>
            ))}
          </ul>
          <div className="grid gap-x-6 gap-y-3 rounded-sm border border-rule bg-surface p-5 md:grid-cols-[auto_1fr]">
            <p className="flex items-baseline gap-2 md:flex-col md:gap-1">
              <span className={`font-display text-38 tnum ${waiting ? "text-ink" : "text-ok"}`}>{waiting}</span>
              <span className="text-13 text-ink-2 md:max-w-[9rem]">{waiting === 1 ? "person has" : "people have"} no password yet</span>
            </p>
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="text-15 font-semibold">Personal links for imported people</h3>
              <p className="max-w-[760px] text-14 text-ink-2">
                People who came in through an import have an account but no password.{" "}
                {mailOn
                  ? "Make each of them a personal link here: the portal mails it to them, and it lets that one person set a password, once, within 14 days."
                  : "The portal sends no mail: make each of them a personal link here and send it; it lets that one person set a password, once, within 14 days."}
              </p>
              <ClaimLinksForm eventSlug={event.slug} waiting={waiting} elsewhere={elsewhere} />
            </div>
          </div>
        </section>

        <section aria-labelledby="share-title" className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="share-title" className="scroll-mt-6 text-20 font-semibold">
              <SectionNo n={5} />
            Put the gallery on your site
            </h2>
            <Link href={`/embed/${event.slug}`} className="text-13 underline underline-offset-4">
              Preview
            </Link>
          </div>
          <p className="max-w-[760px] text-15 text-ink-2">
            Paste this where the gallery should appear; it grows to fit its projects. Add{" "}
            <code className="font-mono text-13">{'data-track="Track name"'}</code> to show one track.
          </p>
          <div className="flex flex-col items-start gap-2 sm:flex-row">
            <pre className="w-full min-w-0 flex-1 whitespace-pre-wrap break-all rounded-sm border border-rule bg-raised px-3 py-2 font-mono text-12">{snippet}</pre>
            <CopyButton text={snippet} label="Copy snippet" />
          </div>
        </section>
      </div>
    </WorkShell>
  );
}

/** A section's number before its heading, as the settings sheet numbers its sections. */
function SectionNo({ n }: { n: number }) {
  return (
    <span aria-hidden className="mr-2.5 font-mono text-13 font-normal text-ink-3">
      {String(n).padStart(2, "0")}
    </span>
  );
}

type ContentsEntry = { id: string; title: string; holds: string; mark: "set" | "open" | "flag" };

/**
 * The page's five parts in one row, each saying what it holds now, drawn as the
 * overview's pipeline stations: a filled square for a part in use, an open one for
 * a part not set up yet, orange for one that needs you (a delivery that failed).
 */
function Contents({ entries }: { entries: ContentsEntry[] }) {
  return (
    <nav aria-label="On this page" className="mt-6">
      <ol className="grid grid-cols-2 gap-y-5 md:grid-cols-5">
        {entries.map((e, i) => (
          <li key={e.id} className="relative pt-5 pr-3">
            <span aria-hidden className="absolute top-[4px] right-0 left-0 h-[2px] bg-rule" />
            <span
              aria-hidden
              className={`absolute top-0 left-0 size-[10px] ${
                e.mark === "flag" ? "bg-flag-bar" : e.mark === "set" ? "bg-ink" : "border-[1.5px] border-edge bg-surface"
              }`}
            />
            <a href={`#${e.id}`} className="group -mx-1 block rounded-xs px-1 py-0.5">
              <span className="flex items-baseline gap-1.5">
                <span className="font-mono text-12 text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                <span className="truncate text-14 font-medium text-ink group-hover:underline group-hover:underline-offset-4">{e.title}</span>
              </span>
              <span className={`mt-0.5 block text-12 ${e.mark === "flag" ? "font-medium text-flag" : "text-ink-2"}`}>{e.holds}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

type Hook = ReturnType<typeof listWebhooks>["webhooks"][number];
type Sent = ReturnType<typeof listDeliveries>[number];
type Standing = "delivered" | "failed" | "retrying" | "waiting";

/** How one delivery stands: arrived, failed for good, being retried, or not tried yet. */
function standing(d: Sent): Standing {
  return d.status === "delivered" ? "delivered" : d.status === "failed" ? "failed" : d.attempts ? "retrying" : "waiting";
}

/**
 * One webhook: its address and switch, then its last deliveries as a row of cells
 * (ink when it arrived, orange when it failed for good, dashed orange while it is
 * retried, open while it waits), in the overview's decided-meter language. A
 * webhook with a failed delivery carries the orange "needs you" bar, and its
 * delivery log opens by itself while anything in it has failed a try.
 */
function HookCard({ slug, hook: w, deliveries }: { slug: string; hook: Hook; deliveries: Sent[] }) {
  const failed = w.counts.failed > 0;
  const troubled = deliveries.some((d) => standing(d) === "failed" || standing(d) === "retrying");
  // why the newest try that did not arrive failed: said once on the card, and on a row only when that row's reason differs
  const reason = troubled ? deliveries.find((d) => standing(d) !== "delivered" && d.error)?.error ?? undefined : undefined;
  return (
    <li className={`flex flex-col gap-4 rounded-sm border border-rule bg-surface p-5 ${failed ? "border-l-4 border-l-flag-bar" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <code className="min-w-0 break-all font-mono text-15 text-ink">{w.url}</code>
          <p className="text-13 text-ink-2">
            {w.actions.includes("*") ? "Every audited action" : w.actions.join(", ")} · added {formatUtc(w.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {failed ? <Badge variant="flag">{w.counts.failed} failed</Badge> : null}
          {w.enabled ? <Badge variant="ok">On</Badge> : <Badge>Off</Badge>}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {deliveries.length ? <DeliveryCells deliveries={deliveries} /> : null}
        <p className="text-13 text-ink-2 tnum">
          <span className="text-ink">{w.counts.delivered}</span> delivered · <span className="text-ink">{w.counts.pending}</span> waiting ·{" "}
          <span className={failed ? "font-medium text-flag" : "text-ink"}>{w.counts.failed}</span> failed
          {deliveries.length ? null : <span className="text-ink-3"> · nothing sent yet</span>}
        </p>
        {reason ? (
          <p className="flex max-w-[760px] flex-wrap items-baseline gap-x-3 gap-y-0.5 border-l-2 border-flag-bar pl-3 text-14 text-ink">
            <span className="label-mono text-flag">Last error</span>
            <span>{reason}</span>
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {w.enabled ? (
          <form action={sendTest.bind(null, slug, w.id)}>
            <button className={small}>Send a test</button>
          </form>
        ) : null}
        <form action={toggleWebhook.bind(null, slug, w.id, !w.enabled)}>
          <button className={small}>{w.enabled ? "Turn off" : "Turn on"}</button>
        </form>
        <RotateSecretForm eventSlug={slug} webhookId={w.id} />
      </div>

      {deliveries.length ? (
        <details open={troubled || undefined} className="border-t border-rule pt-3">
          <summary className="cursor-pointer text-13 font-medium text-ink-2 hover:text-ink">Last deliveries, newest first</summary>
          <table className="mt-2 w-full text-13 max-sm:block">
            <thead className="text-left text-12 text-ink-2 max-sm:hidden">
              <tr>
                <th className="py-1.5 pr-4 font-medium">When (UTC)</th>
                <th className="py-1.5 pr-4 font-medium">Action</th>
                <th className="py-1.5 pr-4 font-medium">Tries</th>
                <th className="py-1.5 pr-4 font-medium">Result</th>
                <th className="py-1.5 font-medium">
                  <span className="sr-only">Send again</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule max-sm:block">
              {deliveries.map((d) => (
                <DeliveryRow key={d.id} slug={slug} hookId={w.id} d={d} reason={reason} />
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </li>
  );
}

const CELL: Record<Standing, string> = {
  delivered: "bg-ink",
  failed: "bg-flag-bar",
  retrying: "border-[1.5px] border-dashed border-flag-bar",
  waiting: "border-[1.5px] border-edge",
};

function DeliveryCells({ deliveries }: { deliveries: Sent[] }) {
  const n: Record<Standing, number> = { delivered: 0, failed: 0, retrying: 0, waiting: 0 };
  for (const d of deliveries) n[standing(d)]++;
  const said = (Object.keys(n) as Standing[])
    .filter((k) => n[k])
    .map((k) => `${n[k]} ${k}`)
    .join(", ");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span role="img" aria-label={`The last ${deliveries.length} deliveries: ${said}`} className="flex gap-[3px]">
        {deliveries.map((d) => (
          <span key={d.id} title={`${d.action}: ${standing(d)}`} className={`size-[14px] ${CELL[standing(d)]}`} />
        ))}
      </span>
      <span className="text-12 text-ink-3">the last {deliveries.length}, newest first</span>
    </div>
  );
}

/** The tries a delivery has used, out of the schedule's six, as small cells: orange once it has failed for good. */
function Tries({ d }: { d: Sent }) {
  const s = standing(d);
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span aria-hidden className="flex gap-[2px]">
        {Array.from({ length: MAX_ATTEMPTS }, (_, i) => (
          <span key={i} className={`size-[8px] ${i < d.attempts ? (s === "failed" ? "bg-flag-bar" : "bg-ink") : "border border-edge"}`} />
        ))}
      </span>
      <span className="font-mono text-12 text-ink-2 tnum">
        {d.attempts} of {MAX_ATTEMPTS}
      </span>
    </span>
  );
}

function DeliveryRow({ slug, hookId, d, reason }: { slug: string; hookId: string; d: Sent; reason?: string }) {
  const s = standing(d);
  const td = "py-2 pr-4 align-top max-sm:p-0";
  return (
    <tr className="max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:gap-x-3 max-sm:gap-y-1 max-sm:py-3">
      <td className={`${td} font-mono text-12 whitespace-nowrap text-ink-2`}>{formatUtc(d.createdAt).replace(" UTC", "")}</td>
      <td className={`${td} font-mono text-12 max-sm:col-start-1 max-sm:row-start-2`}>{d.action}</td>
      <td className={`${td} max-sm:col-start-2 max-sm:row-start-1 max-sm:justify-self-end`}>
        <Tries d={d} />
      </td>
      <td className={`${td} max-sm:col-span-2`}>
        {s === "delivered" ? (
          <span className="text-ok">Delivered{d.responseStatus ? `, answered ${d.responseStatus}` : ""}</span>
        ) : s === "failed" ? (
          <span className="font-medium text-flag">Failed for good</span>
        ) : s === "retrying" ? (
          <span>Next try at {formatUtc(d.nextAttemptAt).split(", ")[1]}</span>
        ) : (
          <span className="text-ink-2">Waiting to send</span>
        )}
        {s !== "delivered" && d.error && d.error !== reason ? <span className="mt-0.5 block text-12 text-ink-2">{d.error}</span> : null}
      </td>
      <td className="py-2 text-right align-top max-sm:col-start-2 max-sm:row-start-2 max-sm:p-0">
        {s !== "delivered" && d.attempts >= ATTEMPTS_CAP ? (
          <span className="text-12 whitespace-nowrap text-ink-2">Tried {ATTEMPTS_CAP} times</span>
        ) : s !== "delivered" ? (
          <form action={retry.bind(null, slug, hookId, d.id)}>
            <button className="text-13 whitespace-nowrap underline underline-offset-4">Send again</button>
          </form>
        ) : null}
      </td>
    </tr>
  );
}
