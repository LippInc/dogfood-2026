import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * The Results tab's method, one click away: a closed <details> with a plain summary line, so an
 * organizer meets what the page tells them before k, β̂² and σ̂² (the judge's-eye reading and the
 * Organizer-operations check, 2026-09-29, found the formula opening the page). The same fold as
 * the public results page's "How these scores were made"; a native <details> opens with Enter
 * or Space, and its summary takes the global focus ring.
 */
export function MethodFold({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <details className="group max-w-[860px] rounded-sm border border-rule text-ink-2" data-method-fold="">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block text-15 font-semibold text-ink">{title}</span>
          <span className="block text-13 text-ink-3">{hint}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-ink-2 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
      </summary>
      <div className="border-t border-rule px-4 pt-3 pb-4 text-15 leading-6 wrap-anywhere">{children}</div>
    </details>
  );
}
