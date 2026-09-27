import type { Metadata } from "next";
import Link from "next/link";
import { DEMO_STEPS } from "@/components/demo-tour";
import { Face } from "@/components/face";
import { PlainShell } from "@/components/shell/plain-shell";
import { demoIdentities } from "@/server/dal";
import { demoSignIn } from "./actions";
import { PasswordForm } from "./password-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

const WHAT: Record<string, string> = {
  ...Object.fromEntries(DEMO_STEPS.map((s) => [s.label, s.what])),
  judge_b: "A second judge on other projects: the same console, and a 403 if it asks for Judge A's scores.",
};

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
      <div className="grid gap-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
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
                  <form action={demoSignIn} className="tile grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-4 gap-y-3 py-4 sm:grid-cols-[64px_minmax(0,1fr)_auto] sm:items-center">
                    <input type="hidden" name="label" value={d.label} />
                    <span className="overflow-hidden rounded-xs border border-rule">
                      <Face id={d.userId} cols={32} rows={18} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-15 font-medium">{d.name}</p>
                      <p className="text-13 text-ink-3">
                        {LABEL[d.label]} · {d.detail}
                      </p>
                      {WHAT[d.label] ? <p className="mt-1 text-13 text-ink-2">{WHAT[d.label]}</p> : null}
                    </div>
                    <button className="col-start-2 h-10 justify-self-start rounded-sm border border-edge px-4 text-14 hover:bg-raised sm:col-start-3">
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
