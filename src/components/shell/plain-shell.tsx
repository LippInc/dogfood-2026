import { PageMark } from "@/components/page-mark";
import { PlainFrame } from "./plain-frame";

/**
 * The public side's frame for pages that belong to no single event: the event list,
 * sign-in, sign-up, invites, refusals. `account` adds the top bar's account controls:
 * left out, none (the sign-in and sign-up pages); null, Sign in; a name, Sign out.
 * The page's mark hangs from the top bar's right-hand corner, inside the space above
 * the content, fading down and to the left; `mark` adds to its seed (a refusal's status).
 */
export function PlainShell({
  children,
  width,
  account,
  mark,
}: {
  children: React.ReactNode;
  width?: string;
  account?: { name: string } | null;
  mark?: string;
}) {
  return (
    <PlainFrame
      width={width}
      account={account}
      mark={
        <>
          <PageMark anchor="top-right" cols={28} rows={9} extra={mark} className="absolute top-0 right-4 sm:right-8 md:hidden" />
          <PageMark anchor="top-right" cols={64} rows={16} extra={mark} className="absolute top-0 right-8 hidden md:block xl:right-16" />
        </>
      }
    >
      {children}
    </PlainFrame>
  );
}
