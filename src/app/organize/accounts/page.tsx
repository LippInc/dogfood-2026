import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { WorkShell } from "@/components/shell/work-shell";
import { guardPage } from "@/lib/page-guard";
import { currentActor, emailIsOn, guardAccounts, listPortalOutbox } from "@/server/dal";
import { OutboxTable } from "@/components/outbox-table";
import { ResetLinkForm } from "./reset-link-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Accounts" };

// How a reset goes, in the order it happens: the administrator's part is steps 2 and 3,
// the only ones this page does. Said once here, beside the form, instead of a paragraph above it.
const steps = (mailOn: boolean): React.ReactNode[] => [
  "Someone who lost their password asks you, outside the portal.",
  "You make a one-time link for their address here. It works once, within a day; a new one replaces an unused one.",
  mailOn
    ? "The portal mails it to their own address, and shows it here once in case the mail goes astray."
    : "You give it to them yourself. The portal sends no email.",
  "They set a new password on it. That signs the account out everywhere; its API tokens keep working until their owner revokes them.",
  <>
    Both steps are written to the{" "}
    <Link href="/organize/log" className="font-medium text-ink underline underline-offset-4">
      Portal log
    </Link>
    .
  </>,
];

/** Password resets, for the portal's administrators. */
export default async function AccountsPage() {
  const actor = await currentActor();
  if (!actor) unauthorized();
  guardPage(() => guardAccounts(actor));
  const mailOn = emailIsOn();
  const portalMail = listPortalOutbox(actor);
  return (
    <WorkShell eventName="Dogfood portal" eventHref="/organize" crumb="Accounts" person={actor.name} role="Administrator">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-8">
        <header>
          <p className="label-mono text-ink-2">Administrator · the whole portal</p>
          <h1 className="mt-1 text-24 font-semibold">Accounts</h1>
          <p className="mt-2 max-w-[640px] text-15 text-ink-2">
            {mailOn
              ? "Make a one-time link for someone who lost their password; the portal mails it to their own address."
              : "Make a one-time link for someone who lost their password, and hand it over yourself."}
          </p>
        </header>
        <div className="grid items-start gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-labelledby="reset-title" className="flex min-w-0 flex-col gap-4">
            <h2 id="reset-title" className="text-17 font-semibold">
              Password reset
            </h2>
            <ResetLinkForm />
          </section>
          <aside aria-labelledby="steps-title" className="lg:pt-1">
            <h2 id="steps-title" className="label-mono text-ink-2">
              How a reset goes
            </h2>
            <ol className="mt-3 border-t border-rule">
              {steps(emailIsOn()).map((step, i) => (
                <li key={i} className={`grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2 border-b border-rule py-2.5 text-14 ${i === 1 || i === 2 ? "text-ink" : "text-ink-2"}`}>
                  <span className={`font-mono text-12 leading-5 tnum ${i === 1 || i === 2 ? "text-accent-ink" : "text-ink-3"}`}>{String(i + 1).padStart(2, "0")}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-13 text-ink-3">Steps 02 and 03 are yours; this page does 02.</p>
          </aside>
        </div>
        {portalMail.length || mailOn ? (
          <section aria-labelledby="mail-title" className="flex flex-col gap-3">
            <h2 id="mail-title" className="text-17 font-semibold">
              Mailed from here
            </h2>
            {portalMail.length ? (
              <OutboxTable mail={portalMail} />
            ) : (
              <p className="text-14 text-ink-2">Nothing mailed yet: a reset link made here is mailed to the account&rsquo;s own address.</p>
            )}
          </section>
        ) : null}
      </div>
    </WorkShell>
  );
}
