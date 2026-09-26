"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** "Sign in" that comes back to this page afterwards. */
export function SignInLink({ label = "Sign in" }: { label?: string }) {
  const path = usePathname();
  const search = useSearchParams().toString();
  const next = path + (search ? `?${search}` : "");
  return (
    <Link
      href={`/sign-in?next=${encodeURIComponent(next)}`}
      className="inline-flex h-10 items-center rounded-sm border border-primary bg-primary px-4 text-15 font-medium text-on-primary hover:opacity-90"
    >
      {label}
    </Link>
  );
}
