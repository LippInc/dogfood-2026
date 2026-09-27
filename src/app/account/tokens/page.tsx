import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { PlainShell } from "@/components/shell/plain-shell";
import { Badge } from "@/components/ui/badge";
import { formatUtc, isPast } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, listApiTokens } from "@/server/dal";
import { revokeTokenAction } from "./actions";
import { TokenForm } from "./token-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "API tokens" };

const DAY = 86_400_000;
const daysLeft = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / DAY);

export default async function TokensPage() {
  const actor = await currentActor();
  if (!actor) unauthorized();
  const tokens = guardPage(() => listApiTokens(actor));
  const base = process.env.PUBLIC_URL ?? "http://localhost:8080";
  const rows = tokens.map((t) => {
    const state = t.revokedAt
      ? ({ kind: "revoked", when: t.revokedAt } as const)
      : t.expiresAt && isPast(t.expiresAt)
        ? ({ kind: "expired", when: t.expiresAt } as const)
        : ({ kind: "live" } as const);
    return { ...t, state };
  });
  const live = rows.filter((r) => r.state.kind === "live");
  const dead = rows.filter((r) => r.state.kind !== "live");
  return (
    <PlainShell width="max-w-[1040px]" account={{ name: actor.name }}>
      <p className="label-mono text-ink-3">Your account</p>
      <h1 className="mt-2 font-display text-38">API tokens</h1>
      <div className="mt-6 grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,440px)] md:items-start">
        <p className="max-w-[560px] text-15 text-ink-2">
          For scripts that use the{" "}
          <Link href="/api-docs" className="underline underline-offset-4">
            API
          </Link>
          : send a token as <code className="font-mono text-13">Authorization: Bearer &lt;token&gt;</code>. It acts as you, {actor.name}, with exactly your
          permissions, so make one per script and revoke it when the script is gone. A token cannot make or revoke tokens.
        </p>
        <figure className="min-w-0">
          <figcaption className="label-mono text-ink-3">Fig. 01 — a token at work</figcaption>
          <pre className="mt-2 overflow-x-auto rounded-sm border border-rule bg-surface px-4 py-3 font-mono text-13 leading-6 text-ink-2">
            <span className="text-ink-3">$ </span>
            <span className="text-ink">curl</span> -H <span className="text-accent-ink">&quot;Authorization: Bearer dfk_…&quot;</span> \
            {"\n"}
            {"    "}
            {base}/api/events
          </pre>
        </figure>
      </div>

      <section aria-labelledby="new-token" className="mt-10 rounded-sm border border-rule bg-surface p-5">
        <h2 id="new-token" className="mb-4 flex items-baseline gap-3">
          <span className="font-mono text-12 text-accent-ink">01</span>
          <span className="label-mono text-ink-2">New token</span>
        </h2>
        <TokenForm />
      </section>

      <section aria-labelledby="your-tokens" className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-3">
          <h2 id="your-tokens" className="flex items-baseline gap-3">
            <span className="font-mono text-12 text-accent-ink">02</span>
            <span className="label-mono text-ink-2">Your tokens</span>
          </h2>
          {rows.length ? (
            <p className="text-13 text-ink-2 tnum">
              {live.length} working{dead.length ? ` · ${dead.length} revoked or expired` : ""}
            </p>
          ) : null}
        </div>
        {rows.length ? (
          <table className="w-full text-14">
            <thead className="max-md:sr-only">
              <tr className="border-b border-rule text-left text-12 text-ink-3">
                <th scope="col" className="py-2 pr-4 font-normal">
                  Name
                </th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  Starts with
                </th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  Made
                </th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  Last used
                </th>
                <th scope="col" className="py-2 pr-4 font-normal">
                  Status
                </th>
                <th scope="col" className="py-2 font-normal">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...live, ...dead].map((t) => {
                const days = t.expiresAt ? daysLeft(t.expiresAt) : null;
                return (
                  <tr key={t.id} className="border-b border-rule align-middle max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:py-3">
                    <td className={`py-3 pr-4 font-medium wrap-anywhere max-md:col-start-1 max-md:py-0 ${t.state.kind === "live" ? "" : "text-ink-2"}`}>{t.name}</td>
                    <td className="py-3 pr-4 max-md:col-start-1 max-md:py-0">
                      <code
                        className={`rounded-xs border border-rule bg-sunken px-1.5 py-0.5 font-mono text-12 ${t.state.kind === "live" ? "text-ink" : "text-ink-3 line-through"}`}
                      >
                        {t.hint}…
                      </code>
                    </td>
                    <td className="py-3 pr-4 text-13 text-ink-2 tnum max-md:col-start-1 max-md:py-0">
                      <span className="md:hidden">made </span>
                      {formatUtc(t.createdAt)}
                    </td>
                    <td className="py-3 pr-4 text-13 text-ink-2 tnum max-md:col-start-1 max-md:py-0">
                      {t.lastUsedAt ? (
                        <>
                          <span className="md:hidden">last used </span>
                          {formatUtc(t.lastUsedAt)}
                        </>
                      ) : (
                        "never used"
                      )}
                    </td>
                    <td className="py-3 pr-4 max-md:col-start-1 max-md:py-0">
                      {t.state.kind === "revoked" ? (
                        <span className="flex flex-col gap-0.5">
                          <Badge>Revoked</Badge>
                          <span className="text-12 text-ink-3 tnum">{formatUtc(t.state.when)}</span>
                        </span>
                      ) : t.state.kind === "expired" ? (
                        <span className="flex flex-col gap-0.5">
                          <Badge>Expired</Badge>
                          <span className="text-12 text-ink-3 tnum">{formatUtc(t.state.when)}</span>
                        </span>
                      ) : (
                        <span className="flex flex-col gap-0.5">
                          <Badge variant={days !== null && days <= 7 ? "flag" : "ok"}>Working</Badge>
                          <span className="text-12 text-ink-2 tnum">
                            {t.expiresAt ? `expires ${formatUtc(t.expiresAt, { time: false })}${days !== null && days <= 30 ? ` · ${days} d left` : ""}` : "does not expire"}
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-right max-md:col-start-2 max-md:row-span-5 max-md:row-start-1 max-md:self-start max-md:py-0">
                      {t.state.kind === "live" ? (
                        <form action={revokeTokenAction.bind(null, t.id)}>
                          <button
                            className="inline-flex h-8 items-center rounded-sm border border-edge px-3 text-13 font-medium hover:border-flag-bar hover:bg-flag-bg hover:text-flag"
                            aria-label={`Revoke ${t.name}`}
                          >
                            Revoke
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="mt-4 rounded-sm border border-dashed border-edge px-5 py-8 text-center">
            <p className="text-15 font-medium">No tokens yet</p>
            <p className="mt-1 text-14 text-ink-2">Make one above for each script that talks to the API; it is shown to you once.</p>
          </div>
        )}
      </section>
    </PlainShell>
  );
}
