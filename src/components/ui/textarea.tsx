import * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-24 w-full rounded-sm border border-edge bg-surface px-3 py-2 text-15 text-ink placeholder:text-ink-3 disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-2 aria-invalid:border-l-[3px] aria-invalid:border-flag-bar",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
