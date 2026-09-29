import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { PlainShell } from "@/components/shell/plain-shell";
import { Badge } from "@/components/ui/badge";
import { formatUtc, isPast } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, listApiTokens, publicUrl, type TokenView } from "@/server/dal";
import { revokeTokenAction } from "./actions";
import { TokenForm } from "./token-form";
import { TokenMark } from "./token-mark";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "API tokens" };

const DAY = 86_400_000;
const daysLeft = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / DAY);

export default async function TokensPage() {
  const actor = await currentActor();
  if (!actor) unauthorized();
  const tokens = guardPage(() => listApiTokens(actor));
  const base = publicUrl();
  const rows = tokens.map((t) => {
    const state = t.revokedAt
      ? ({ kind: "revoked", when: t.revokedAt } as const)
      : t.expiresAt && isPast(t.expiresAt)
        ? ({ kind: "expired", when: t.expiresAt } as const)
        : ({ kind: "live" } as const);
    return { ...t, state } as Row;
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
          permissions, so make one per script and revoke it when the script is gone. A token cannot list, make or revoke tokens.
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
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="new-token" className="flex items-baseline gap-3">
            <span className="font-mono text-12 text-accent-ink">01</span>
            <span className="label-mono text-ink-2">New token</span>
          </h2>
          <p className="text-12 text-ink-3">shown to you once; the portal keeps only its hash</p>
        </div>
        <TokenForm />
      </section>

      <section aria-labelledby="your-tokens" className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-3">
          <h2 id="your-tokens" className="flex items-baseline gap-3">
            <span className="font-mono text-12 text-accent-ink">02</span>
            <span className="label-mono text-ink-2">Your tokens</span>
          </h2>
        </div>
        {rows.length ? (
          <>
            <table className="w-full text-14">
              <thead className="max-md:sr-only">
                <tr className="border-b border-rule text-left text-12 text-ink-3">
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Token
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Last used
                  </th>
                  <th scope="col" className="py-2 pr-4 font-normal">
                    Expires
                  </th>
                  <th scope="col" className="py-2 font-normal">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <Group title="Working" count={live.length} rows={live} />
              <Group title="Revoked or expired" count={dead.length} rows={dead} />
            </table>
            <p className="mt-3 text-12 text-ink-3">
              Each mark is its token&rsquo;s first six characters after dfk_, drawn as bits: one row of six per character.
            </p>
          </>
        ) : (
          <div className="mt-4 flex items-start gap-4 rounded-sm border border-dashed border-edge px-5 py-6">
            {/* where the first token's mark will sit */}
            <span className="size-9 shrink-0 rounded-xs border border-dashed border-edge" aria-hidden="true" />
            <span>
              <span className="block text-15 font-medium">No tokens yet</span>
              <span className="mt-1 block max-w-[560px] text-14 text-ink-2">
                Make one above for each script that talks to the API. Each gets a row here with its mark, drawn from its first characters, and shows when it was
                last used and when it expires.
              </span>
            </span>
          </div>
        )}
      </section>
    </PlainShell>
  );
}

type Row = TokenView & { state: { kind: "live" } | { kind: "revoked" | "expired"; when: string } };

/** One state's rows under a label row: working tokens need no badge, only the ones that need you (a last week) or are gone say so. */
function Group({ title, count, rows }: { title: string; count: number; rows: Row[] }) {
  if (!rows.length) return null;
  return (
    <tbody>
      <tr className="border-b border-rule">
        <th scope="colgroup" colSpan={4} className="pt-6 pb-2 text-left font-normal">
          <span className="label-mono text-ink-3">
            {title} <span className="tnum">· {count}</span>
          </span>
        </th>
      </tr>
      {rows.map((t) => {
        const live = t.state.kind === "live";
        const days = t.expiresAt ? daysLeft(t.expiresAt) : null;
        return (
          <tr
            key={t.id}
            className="border-b border-rule align-middle max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:py-4"
          >
            <td className="py-3.5 pr-4 max-md:col-start-1 max-md:py-0">
              <span className="flex items-center gap-3">
                <TokenMark hint={t.hint} dim={!live} className="size-9" />
                <span className="min-w-0">
                  <span className={`block font-medium wrap-anywhere ${live ? "" : "text-ink-2"}`}>{t.name}</span>
                  <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-12 text-ink-3 tnum">
                    <code className={`font-mono text-12 ${live ? "text-ink-2" : "line-through"}`}>{t.hint}…</code>
                    <span>made {formatUtc(t.createdAt, { time: false })}</span>
                  </span>
                </span>
              </span>
            </td>
            <td className="py-3.5 pr-4 text-13 tnum max-md:col-start-1 max-md:py-0 max-md:pl-12">
              {t.lastUsedAt ? (
                <span className="text-ink-2">
                  <span className="md:hidden">last used </span>
                  {formatUtc(t.lastUsedAt)}
                </span>
              ) : (
                <span className="text-ink-3">never used</span>
              )}
            </td>
            <td className="py-3.5 pr-4 text-13 tnum max-md:col-start-1 max-md:py-0 max-md:pl-12">
              {t.state.kind === "live" ? (
                t.expiresAt ? (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-2">
                    <span>
                      <span className="md:hidden">expires </span>
                      {formatUtc(t.expiresAt, { time: false })}
                    </span>
                    {days !== null && days <= 7 ? (
                      <Badge variant="flag">{days} d left</Badge>
                    ) : days !== null && days <= 30 ? (
                      <span className="text-ink-3">· {days} d left</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-ink-2">does not expire</span>
                )
              ) : (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-3">
                  <Badge>{t.state.kind === "revoked" ? "Revoked" : "Expired"}</Badge>
                  <span>{formatUtc(t.state.when, { time: false })}</span>
                </span>
              )}
            </td>
            <td className="py-3.5 text-right max-md:col-start-2 max-md:row-span-3 max-md:row-start-1 max-md:self-start max-md:py-0">
              {live ? (
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
  );
}
