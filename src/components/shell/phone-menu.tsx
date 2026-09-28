"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * The public shell's phone menu: a <details> (it opens and its links work before the
 * page's script arrives) that also closes the way a menu should once the script runs:
 * after a link or button in it is used, on Escape (focus goes back to the Menu button),
 * on a tap or click outside it, and whenever the page changes under it.
 */
export function PhoneMenu({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !menu.open) return;
      menu.open = false;
      menu.querySelector("summary")?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);

  return (
    <details ref={ref} className="relative md:hidden">
      <summary className="flex size-11 cursor-pointer list-none items-center justify-center rounded-sm [&::-webkit-details-marker]:hidden">
        <Menu className="size-5" aria-hidden />
        <span className="sr-only">Menu</span>
      </summary>
      <div
        className="absolute right-0 z-40 mt-1 w-64 rounded-sm border border-rule bg-surface p-2 shadow-overlay"
        onClick={(e) => {
          // a link was followed: the menu has done its job (sign-out leaves the page anyway)
          if ((e.target as HTMLElement).closest("a") && ref.current) ref.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
