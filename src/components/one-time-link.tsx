import Link from "next/link";
import { PlainShell } from "@/components/shell/plain-shell";
import { Ticket, TicketNote } from "@/components/ticket";
import { buttonVariants } from "@/components/ui/button";

/**
 * The one-time links a person is handed (a password reset, an imported person's
 * personal link) drawn as the invitations' ticket: the page on the left, a stub that
 * says how many uses the link has left. The face is drawn from the link itself, so
 * the same link keeps the same face whether it works or not. Used by /reset/[token]
 * and /claim/[token] only.
 */
export type LinkKind = "reset" | "claim";

/** The link's one use as a pixel: filled while it works, dashed once it is used or expired. Decorative; the stub's number says it. */
function UseMark({ left }: { left: boolean }) {
  return <span aria-hidden="true" className={`block size-4 rounded-xs ${left ? "bg-ink" : "border border-dashed border-edge"}`} />;
}

export function LinkTicket({
  kind,
  token,
  works,
  stubNote,
  children,
}: {
  kind: LinkKind;
  token: string;
  works: boolean;
  stubNote?: string;
  children: React.ReactNode;
}) {
  return (
    <PlainShell width="max-w-[800px]">
      <Ticket
        faceId={`${kind}:${token}`}
        stubHead="Admit one"
        stubLabel="Uses left"
        stubValue={works ? "1 of 1" : "0 of 1"}
        stubArt={<UseMark left={works} />}
        stubNote={stubNote}
      >
        {children}
      </Ticket>
    </PlainShell>
  );
}

const ASK: Record<LinkKind, string> = {
  reset: "It was never used. Ask the portal's administrator for a new one: they make it on the Accounts page, and it replaces this one.",
  claim: "It was never used. Ask the event's organizers for a new one: they make personal links on the event's Integrations page.",
};
const USED: Record<LinkKind, string> = {
  reset: "The new password was set with it. Sign in with that password.",
  claim: "The account's password was set with it. Sign in with that password.",
};

/**
 * A link that exists but no longer works: used, expired, or (a personal link) out of
 * its organizer's reach. Said once each: the heading names what happened, one line
 * says what to do. A used link needs nothing from the reader (plain line, Sign in);
 * the others need them to ask someone for a new one (the flag colour). The
 * out-of-reach case carries the server's own sentence, which names who to ask.
 */
export function GoneLink({ kind, token, code, message }: { kind: LinkKind; token: string; code: string; message: string }) {
  const used = code.endsWith("_used");
  const expired = code.endsWith("_expired");
  const title = used ? "This link was used" : expired ? "This link has expired" : "This link no longer works";
  return (
    <LinkTicket kind={kind} token={token} works={false} stubNote={used ? "Used" : expired ? "Expired" : "Stopped"}>
      <p className="label-mono text-ink-3">{kind === "reset" ? "Password reset · one-time link" : "Personal link"}</p>
      <h1 className="mt-3 font-display text-38">{title}</h1>
      <div className="mt-4 flex flex-col gap-6">
        {used ? <p className="text-17 text-ink-2">{USED[kind]}</p> : <TicketNote flag>{expired ? ASK[kind] : message}</TicketNote>}
        <Link href={used ? "/sign-in" : "/"} className={`${buttonVariants({ variant: used ? "primary" : "outline", size: "xl" })} self-start`}>
          {used ? "Sign in" : "Go to the projects"}
        </Link>
      </div>
    </LinkTicket>
  );
}

/** What pressing the button does, said before the button: one hairline row per consequence. */
export function Consequences({ items }: { items: React.ReactNode[] }) {
  return (
    <div>
      <p className="label-mono text-ink-3">What saving does</p>
      <ol className="mt-2 border-t border-rule">
        {items.map((item, i) => (
          <li key={i} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2 border-b border-rule py-2.5 text-15">
            <span className="font-mono text-12 leading-6 text-ink-3 tnum">{String(i + 1).padStart(2, "0")}</span>
            <span>{item}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
