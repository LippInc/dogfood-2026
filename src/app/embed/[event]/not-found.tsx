import type { Metadata } from "next";
import { DitherDigits } from "@/components/dither-digits";
import { PageMark } from "@/components/page-mark";
import { ReportHeight } from "./height";

export const metadata: Metadata = { title: "Event not found", robots: { index: false } };

// An unknown event inside the embed: still a real 404, without the portal's top bar (it sits
// in a frame on the organizers' own site), but as big as the portal's own 404, so the frame
// the organizer placed shows it plainly. The one who sees it is usually the organizer placing
// the embed, so it says what to check.
export default function EmbedNotFound() {
  return (
    <div className="public min-h-0 p-4 wrap-anywhere">
      <ReportHeight />
      <div className="relative flex flex-col items-center gap-8 overflow-hidden rounded-xs border border-rule bg-surface px-4 py-12 text-center sm:py-16">
        <PageMark anchor="right" cols={40} rows={6} extra="404" className="absolute top-0 right-0" />
        <div className="w-full max-w-[440px] overflow-hidden rounded-xs border border-rule" aria-hidden="true">
          <DitherDigits value="404" />
        </div>
        <div className="max-w-[560px]">
          <p className="label-mono text-accent-ink">404 · Not found</p>
          <h1 className="mt-3 font-display text-24 sm:text-38">No gallery at this address</h1>
          <p className="mt-3 text-15 text-ink-2">
            No event has this name on the portal. Check the event in the embed code (its <code className="font-mono text-13">data-event</code>): it is
            the part of the gallery&rsquo;s address after <code className="font-mono text-13">/events/</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
