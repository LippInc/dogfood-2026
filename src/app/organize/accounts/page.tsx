import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { WorkShell } from "@/components/shell/work-shell";
import { guardPage } from "@/lib/page-guard";
import { currentActor, guardAccounts } from "@/server/dal";
import { ResetLinkForm } from "./reset-link-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Accounts" };

/** Password resets, for the portal's administrators. */
export default async function AccountsPage() {
  const actor = await currentActor();
  if (!actor) unauthorized();
  guardPage(() => guardAccounts(actor));
  return (
    <WorkShell eventName="Dogfood portal" eventHref="/organize" crumb="Accounts" person={actor.name} role="Administrator">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
        <header>
          <h1 className="text-24 font-semibold">Accounts</h1>
          <p className="mt-2 max-w-[760px] text-15 text-ink-2">
            Someone who lost their password asks you. Make a one-time link for their address and give it to them yourself: the portal sends no email.
            The link works once, within a day, and a new one replaces an unused one. Setting the new password signs the account out everywhere; its
            API tokens keep working until their owner revokes them. Both steps are in the Portal log.
          </p>
        </header>
        <section aria-labelledby="reset-title" className="rounded-sm border border-rule bg-surface p-5">
          <h2 id="reset-title" className="mb-4 text-17 font-semibold">
            Password reset
          </h2>
          <ResetLinkForm />
        </section>
      </div>
    </WorkShell>
  );
}
