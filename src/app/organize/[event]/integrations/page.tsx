import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { LiveRefresh } from "@/components/live-refresh";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { Badge } from "@/components/ui/badge";
import { formatUtc } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, listDeliveries, listWebhooks } from "@/server/dal";
import { CopyButton } from "../judges/forms";
import { retry, sendTest, toggleWebhook } from "./actions";
import { AddWebhookForm, RotateSecretForm } from "./forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Integrations" };

const small = "inline-flex h-8 items-center rounded-sm border border-edge px-3 text-13 font-medium hover:bg-raised";

export default async function IntegrationsPage({ params }: PageProps<"/organize/[event]/integrations">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, webhooks } = guardPage(() => listWebhooks(actor, key));
  const deliveries = Object.fromEntries(webhooks.map((w) => [w.id, listDeliveries(actor, key, w.id).slice(0, 10)]));
  const origin = process.env.PUBLIC_URL ?? "http://localhost:8080";
  const snippet = `<script src="${origin}/embed.js" data-event="${event.slug}" async></script>`;

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
        </header>

        <section aria-labelledby="api-title" className="flex flex-col gap-3">
          <h2 id="api-title" className="text-20 font-semibold">
            API
          </h2>
          <p className="max-w-[760px] text-15 text-ink-2">
            Every action here is also a JSON route, with the same permission checks. Scripts sign in like a person and send the session token as{" "}
            <code className="font-mono text-13">Authorization: Bearer &lt;token&gt;</code>.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/api-docs" className={small}>
              API reference
            </Link>
            <a href="/api/openapi.json" className={small}>
              OpenAPI document
            </a>
          </div>
        </section>

        <section aria-labelledby="hooks-title" className="flex flex-col gap-5">
          <div>
            <h2 id="hooks-title" className="text-20 font-semibold">
              Webhooks
            </h2>
            <p className="mt-1 max-w-[760px] text-15 text-ink-2">
              Each audited action (a submission, a review, a vote, a published result) is POSTed to your URL as JSON, with the audit row&rsquo;s hash.
              The <code className="font-mono text-13">Dogfood-Signature</code> header is <code className="font-mono text-13">t=&lt;time&gt;,v1=&lt;HMAC-SHA256&gt;</code>{" "}
              over <code className="font-mono text-13">&lt;time&gt;.&lt;body&gt;</code> with the webhook&rsquo;s secret. Failed deliveries are retried
              after 10 s, 1 min, 5 min, 30 min and 2 h. While voting is open a ballot&rsquo;s picks are left out, as everywhere else.
            </p>
          </div>

          {webhooks.length ? (
            <ul className="flex flex-col gap-4">
              {webhooks.map((w) => (
                <li key={w.id} className="flex flex-col gap-3 rounded-sm border border-rule bg-surface p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <code className="min-w-0 break-all font-mono text-14">{w.url}</code>
                    {w.enabled ? <Badge variant="ok">On</Badge> : <Badge>Off</Badge>}
                  </div>
                  <p className="text-14 text-ink-2">
                    {w.actions.includes("*") ? "Every audited action" : w.actions.join(", ")} · added {formatUtc(w.createdAt)} · {w.counts.delivered} delivered,{" "}
                    {w.counts.pending} waiting, {w.counts.failed} failed
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {w.enabled ? (
                      <form action={sendTest.bind(null, event.slug, w.id)}>
                        <button className={small}>Send a test</button>
                      </form>
                    ) : null}
                    <form action={toggleWebhook.bind(null, event.slug, w.id, !w.enabled)}>
                      <button className={small}>{w.enabled ? "Turn off" : "Turn on"}</button>
                    </form>
                    <RotateSecretForm eventSlug={event.slug} webhookId={w.id} />
                  </div>
                  {deliveries[w.id]!.length ? (
                    <details>
                      <summary className="cursor-pointer text-13 text-ink-2 hover:text-ink">Last deliveries</summary>
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full min-w-[640px] text-13">
                          <thead className="text-left text-ink-2">
                            <tr>
                              <th className="py-1.5 pr-3 font-medium">When (UTC)</th>
                              <th className="py-1.5 pr-3 font-medium">Action</th>
                              <th className="py-1.5 pr-3 font-medium">Result</th>
                              <th className="py-1.5 font-medium" />
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-rule">
                            {deliveries[w.id]!.map((d) => (
                              <tr key={d.id}>
                                <td className="py-1.5 pr-3 font-mono text-12 whitespace-nowrap">{formatUtc(d.createdAt)}</td>
                                <td className="py-1.5 pr-3 font-mono text-12">{d.action}</td>
                                <td className="py-1.5 pr-3">
                                  {d.status === "delivered" ? (
                                    <span className="text-ok">Delivered ({d.responseStatus})</span>
                                  ) : d.status === "failed" ? (
                                    <span className="text-flag">Failed after {d.attempts}: {d.error}</span>
                                  ) : d.attempts ? (
                                    <span>
                                      Retrying at {formatUtc(d.nextAttemptAt)}: {d.error}
                                    </span>
                                  ) : (
                                    <span className="text-ink-2">Waiting to send</span>
                                  )}
                                </td>
                                <td className="py-1.5 text-right">
                                  {d.status !== "delivered" ? (
                                    <form action={retry.bind(null, event.slug, w.id, d.id)}>
                                      <button className="text-13 underline underline-offset-4">Send again</button>
                                    </form>
                                  ) : null}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  ) : (
                    <p className="text-13 text-ink-3">Nothing sent yet.</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-14 text-ink-2">No webhooks yet.</p>
          )}

          <div className="rounded-sm border border-rule p-5">
            <h3 className="mb-4 text-15 font-semibold">Add a webhook</h3>
            <AddWebhookForm eventSlug={event.slug} />
          </div>
        </section>

        <section aria-labelledby="share-title" className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="share-title" className="text-20 font-semibold">
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
