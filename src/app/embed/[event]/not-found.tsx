import type { Metadata } from "next";
import { DitherDigits } from "@/components/dither-digits";
import { PageMark } from "@/components/page-mark";
import { ReportHeight } from "./height";

export const metadata: Metadata = { title: "Event not found", robots: { index: false } };

// An unknown event inside the embed: still a real 404, but sized for the frame on the
// organizers' own site, without the portal's top bar. The one who sees it is usually
// the organizer placing the embed, so it says what to check.
export default function EmbedNotFound() {
  return (
    <div className="public min-h-0 p-4 wrap-anywhere">
      <ReportHeight />
      <div className="relative flex flex-col gap-4 overflow-hidden rounded-xs border border-rule bg-surface p-4 min-[480px]:flex-row min-[480px]:items-center min-[480px]:gap-5">
        <PageMark anchor="right" cols={20} rows={4} extra="404" className="absolute top-0 right-0" />
        <div className="w-[136px] shrink-0 overflow-hidden rounded-xs border border-rule" aria-hidden="true">
          <DitherDigits value="404" />
        </div>
        <div className="min-w-0">
          <p className="label-mono text-accent-ink">404 · Not found</p>
          <h1 className="mt-1 font-display text-17 leading-6">No gallery at this address</h1>
          <p className="mt-1 max-w-[52ch] text-13 text-ink-2">
            No event has this name on the portal. Check the event in the embed code (its <code className="font-mono text-12">data-event</code>): it is
            the part of the gallery&rsquo;s address after <code className="font-mono text-12">/events/</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
