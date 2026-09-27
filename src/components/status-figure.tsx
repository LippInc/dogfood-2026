import { DitherDigits } from "@/components/dither-digits";

/** The status as a figure beside a refusal or an error page: the number, and a caption saying it is the real one. */
export function StatusFigure({ status }: { status: string }) {
  return (
    <figure className="flex flex-col gap-3" aria-hidden="true">
      <div className="overflow-hidden rounded-xs border border-rule">
        <DitherDigits value={status} />
      </div>
      <figcaption className="flex items-baseline justify-between gap-4">
        <span className="label-mono text-ink">Fig. {status}</span>
        <span className="text-13 text-ink-3">sent with a real HTTP {status}, never a redirect</span>
      </figcaption>
    </figure>
  );
}
