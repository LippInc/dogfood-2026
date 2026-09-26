import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";

// Badges are text labels, never coloured dots (DESIGN.md): mono, uppercase, a
// hairline border. Colour means something only for "needs you" (flag) and "done" (ok).
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-xs border px-1.5 py-px font-mono text-12 uppercase tracking-[0.08em] [&>svg]:size-3",
  {
    variants: {
      variant: {
        neutral: "border-rule text-ink-2",
        accent: "border-accent text-accent-ink",
        flag: "border-flag-bar bg-flag-bg text-flag",
        ok: "border-rule text-ok",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

function Badge({
  className,
  variant = "neutral",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return <Comp data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
