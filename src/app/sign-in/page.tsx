import type { Metadata } from "next";
import Link from "next/link";
import { PlainShell } from "@/components/shell/plain-shell";
import { demoIdentities } from "@/server/dal";
import { demoSignIn } from "./actions";
import { PasswordForm } from "./password-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

const LABEL: Record<string, string> = {
  organizer: "Organizer",
  judge_a: "Judge A",
  judge_b: "Judge B",
  participant: "Participant",
};

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : null;
  const demo = demoIdentities();
  return (
    <PlainShell>
      <div className="grid gap-12 md:grid-cols-2">
        <section aria-labelledby="signin-title">
          <h1 id="signin-title" className="font-display text-38">
            Sign in
          </h1>
          <p className="mt-2 text-15 text-ink-2">Judges and team members get their account from an invite link.</p>
          <div className="mt-8">
            <PasswordForm next={next} />
          </div>
          <p className="mt-6 text-14 text-ink-2">
            New here?{" "}
            <Link href={next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up"} className="underline decoration-edge underline-offset-4">
              Create an account
            </Link>
          </p>
        </section>
        {demo.length > 0 ? (
          <section aria-labelledby="demo-title" className="rounded-sm border border-rule bg-surface p-6">
            <h2 id="demo-title" className="label-mono text-ink-2">
              Demo identities
            </h2>
            <p className="mt-2 text-14 text-ink-2">
              This portal runs with <code className="font-mono text-13">SEED_CHECKER_SESSIONS=true</code>, the setting for
              demos and judging. Each button starts an ordinary session as one of the four seeded people. Production
              turns the setting off, and these buttons disappear.
            </p>
            <ul className="mt-5 divide-y divide-rule border-y border-rule">
              {demo.map((d) => (
                <li key={d.label}>
                  <form action={demoSignIn} className="flex items-center gap-4 py-3">
                    <input type="hidden" name="label" value={d.label} />
                    <div className="min-w-0 flex-1">
                      <p className="text-15 font-medium">{d.name}</p>
                      <p className="text-13 text-ink-3">
                        {LABEL[d.label]} · {d.detail}
                      </p>
                    </div>
                    <button className="h-10 shrink-0 rounded-sm border border-edge px-4 text-14 hover:bg-raised">
                      Sign in as {LABEL[d.label]}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </PlainShell>
  );
}
