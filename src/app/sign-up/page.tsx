import type { Metadata } from "next";
import Link from "next/link";
import { PlainShell } from "@/components/shell/plain-shell";
import { SignUpForm } from "./sign-up-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create an account" };

export default async function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : null;
  return (
    <PlainShell width="max-w-[520px]">
      <h1 className="font-display text-38">Create an account</h1>
      <p className="mt-2 text-15 text-ink-2">
        An account on its own can do nothing yet: you get a role by starting or joining a team, or when an organizer
        invites you to judge.
      </p>
      <div className="mt-8">
        <SignUpForm next={next} />
      </div>
      <p className="mt-6 text-14 text-ink-2">
        Already have an account?{" "}
        <Link href={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"} className="underline decoration-edge underline-offset-4">
          Sign in
        </Link>
      </p>
    </PlainShell>
  );
}
