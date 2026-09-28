import { Ticket } from "@/components/ticket";
import { formatUtc } from "@/lib/format";
import { ResetLinkBox } from "./reset-link-form";

/**
 * A reset link just made, drawn as the ticket the person will open: the stub's face comes
 * from the same `reset:<token>` as on /reset/<token>, so both of you see the same face,
 * and the stub says it has its one use left. Rendered on the server by the action.
 */
export function ResetTicket({ path, name, email, expiresAt }: { path: string; name: string; email: string; expiresAt: string }) {
  const token = path.split("/").pop() ?? "";
  return (
    <Ticket
      faceId={`reset:${token}`}
      stubHead="Admit one"
      stubLabel="Uses left"
      stubValue="1 of 1"
      stubArt={<span aria-hidden="true" className="block size-4 rounded-xs bg-ink" />}
      stubNote="Their page shows this same face."
    >
      <p className="label-mono text-accent-ink">Password reset · one-time link · just made</p>
      <p className="mt-3 text-20 font-semibold wrap-anywhere">For {name}</p>
      <p className="mt-1 text-15 text-ink-2 wrap-anywhere">{email}</p>
      <div className="mt-5">
        <ResetLinkBox path={path} />
      </div>
      <p className="mt-4 text-14 text-ink-2">
        Shown only now: copy it before you leave this page. It works once, until <span className="font-medium text-ink">{formatUtc(expiresAt)}</span>.
      </p>
    </Ticket>
  );
}
