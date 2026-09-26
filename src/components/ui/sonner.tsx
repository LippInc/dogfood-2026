"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

// Toasts follow the page's own mode: sonner's "system" theme reads color-scheme,
// and the colours come from the tokens, so no theme provider is needed.
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="system"
      position="bottom-right"
      toastOptions={{
        unstyled: false,
        classNames: {
          toast: "!rounded-sm !border !border-rule !bg-surface !text-ink !shadow-overlay !font-sans !text-14",
          description: "!text-ink-2",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
