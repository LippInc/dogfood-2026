"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

// Light / dark switch for the product's own top bar. The choice is stored in the
// "mode" cookie so the server paints it first on the next request; until the first
// click the page follows the operating system.

function effectiveDark(): boolean {
  const set = document.documentElement.dataset.mode;
  if (set === "dark") return true;
  if (set === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
  media.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", onChange);
  };
}

export function ModeToggle({ className = "" }: { className?: string }) {
  const dark = useSyncExternalStore(subscribe, effectiveDark, () => false);
  const toggle = () => {
    const next = effectiveDark() ? "light" : "dark";
    document.documentElement.dataset.mode = next;
    document.cookie = `mode=${next}; path=/; max-age=31536000; samesite=lax`;
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      aria-label="Dark mode"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={`inline-flex size-9 items-center justify-center rounded-sm border border-transparent text-ink-2 hover:border-rule hover:text-ink ${className}`}
    >
      {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </button>
  );
}
