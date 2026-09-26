import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";

// Buttons restyled to the tokens (DESIGN.md): flat, 4px radius, no gradients or
// shadows. The work side uses md (32px); the public side lg (40px), xl (44px) on phones.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm border font-medium select-none transition-colors disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary:
          "border-primary bg-primary text-on-primary hover:opacity-90 disabled:border-rule disabled:bg-sunken disabled:text-ink-3 disabled:opacity-100",
        outline: "border-edge bg-transparent text-ink hover:bg-raised",
        ghost: "border-transparent bg-transparent text-ink-2 hover:bg-raised hover:text-ink",
        accent: "border-accent bg-accent text-on-accent hover:opacity-90",
        link: "h-auto border-transparent px-0 text-ink underline decoration-edge underline-offset-4 hover:decoration-ink",
      },
      size: {
        sm: "h-7 px-2.5 text-13",
        md: "h-8 px-3 text-14",
        lg: "h-10 px-4 text-15",
        xl: "h-11 px-5 text-15",
        icon: "size-8",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

function Button({
  className,
  variant = "primary",
  size = "md",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
