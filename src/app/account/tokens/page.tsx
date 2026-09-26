import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { PlainShell } from "@/components/shell/plain-shell";
import { formatUtc, isPast } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, listApiTokens } from "@/server/dal";
import { revokeTokenAction } from "./actions";
import { TokenForm } from "./token-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "API tokens" };

export default async function TokensPage() {
  const actor = await currentActor();
  if (!actor) unauthorized();
  const tokens = guardPage(() => listApiTokens(actor));
  return (
    <PlainShell width="max-w-[960px]">
      <h1 className="font-display text-38">API tokens</h1>
      <p className="mt-3 max-w-[680px] text-15 text-ink-2">
        For scripts that use the{" "}
        <Link href="/api-docs" className="underline underline-offset-4">
          API
        </Link>
        : send a token as <code className="font-mono text-13">Authorization: Bearer &lt;token&gt;</code>. It acts as you, {actor.name}, with exactly your
        permissions, so make one per script and revoke it when the script is gone. A token cannot make or revoke tokens.
      </p>

      <section aria-labelledby="new-token" className="mt-8 rounded-sm border border-rule bg-surface p-5">
        <h2 id="new-token" className="mb-4 text-15 font-semibold">
          New token
        </h2>
        <TokenForm />
      </section>

      <section aria-labelledby="your-tokens" className="mt-10">
        <h2 id="your-tokens" className="border-b border-rule pb-2 text-20 font-semibold">
          Your tokens
        </h2>
        {tokens.length ? (
          <ul className="divide-y divide-rule">
            {tokens.map((t) => {
              const dead = t.revokedAt
                ? `revoked ${formatUtc(t.revokedAt)}`
                : t.expiresAt && isPast(t.expiresAt)
                  ? `expired ${formatUtc(t.expiresAt)}`
                  : null;
              return (
                <li key={t.id} className={`flex flex-wrap items-center justify-between gap-3 py-3 ${dead ? "opacity-60" : ""}`}>
                  <div className="min-w-0">
                    <p className="text-15 font-medium">
                      {t.name} <code className="font-mono text-12 text-ink-3">{t.hint}…</code>
                    </p>
                    <p className="text-13 text-ink-2">
                      made {formatUtc(t.createdAt)} · {t.lastUsedAt ? `last used ${formatUtc(t.lastUsedAt)}` : "never used"} ·{" "}
                      {dead ?? (t.expiresAt ? `expires ${formatUtc(t.expiresAt)}` : "does not expire")}
                    </p>
                  </div>
                  {dead ? null : (
                    <form action={revokeTokenAction.bind(null, t.id)}>
                      <button className="inline-flex h-8 items-center rounded-sm border border-edge px-3 text-13 font-medium hover:bg-raised">Revoke</button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-14 text-ink-2">No tokens yet.</p>
        )}
      </section>
    </PlainShell>
  );
}
