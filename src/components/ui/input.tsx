import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-sm border border-edge bg-surface px-3 text-15 text-ink placeholder:text-ink-3 file:border-0 file:bg-transparent file:text-14 file:font-medium disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-2 aria-invalid:border-l-[3px] aria-invalid:border-flag-bar",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
