import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
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
  judge_b: "A second judge on other projects: the same console, refused (403) if it asks for Judge A's scores.",
};

/** Where a ?next= path leads, in words; the path itself is shown under it. */
function destination(path: string): string {
  const [, first, , third] = path.split("?")[0].split("/");
  if (first === "judge") return "the judge console";
  if (first === "organize") return "the organizer's pages";
  if (first === "judge-invite") return "your judge invitation";
  if (first === "join") return "the team invitation";
  if (first === "vote") return "the vote";
  if (first === "account") return "your account";
  if (first === "events" && third === "my-project") return "your team's project";
  return "the page you asked for";
}

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
          {next ? (
            <div className="mt-6 rounded-xs border border-rule bg-sunken px-4 py-3">
              <p className="label-mono text-ink-3">Then back to</p>
              <p className="mt-1 text-15">
                {destination(next)}
                <span className="mt-0.5 block truncate font-mono text-13 text-ink-2">{next}</span>
              </p>
            </div>
          ) : null}
          <div className="mt-8">
            <PasswordForm next={next} />
          </div>
          <div className="mt-6 flex flex-col gap-2 text-14 text-ink-2">
            <p>
              New here?{" "}
              <Link href={next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up"} className="underline decoration-edge underline-offset-4 hover:decoration-ink">
                Create an account
              </Link>
            </p>
            <p>Forgot the password? Ask the portal&apos;s administrator for a reset link: they make one on the Accounts page.</p>
          </div>
        </section>
        {demo.length > 0 ? (
          <section aria-labelledby="demo-title" className="self-start rounded-sm border border-rule bg-surface p-6 sm:p-8">
            <h2 id="demo-title" className="label-mono text-accent-ink">
              Demo portal · one-click sign-in
            </h2>
            <p className="mt-3 text-15 text-ink-2">
              Pick one of the four seeded people to see the portal as them: an ordinary session, no password.
            </p>
            <ul className="mt-6 border-t border-rule">
              {demo.map((d) => (
                <li key={d.label} className="border-b border-rule">
                  <form action={demoSignIn}>
                    <input type="hidden" name="label" value={d.label} />
                    {next ? <input type="hidden" name="next" value={next} /> : null}
                    <button
                      aria-label={`Sign in as ${d.name}, ${LABEL[d.label]}`}
                      aria-describedby={WHAT[d.label] ? `demo-${d.label}-what` : undefined}
                      className="tile group grid w-full cursor-pointer grid-cols-[72px_minmax(0,1fr)] items-start gap-x-4 px-2 py-4 text-left transition-colors hover:bg-raised focus-visible:-outline-offset-2 motion-reduce:transition-none sm:grid-cols-[88px_minmax(0,1fr)_auto]"
                    >
                      <span className="mt-1 overflow-hidden rounded-xs border border-rule">
                        <Face id={d.userId} cols={32} rows={18} />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-15 font-semibold">{d.name}</span>
                          <span className="label-mono text-accent-ink">{LABEL[d.label]}</span>
                        </span>
                        <span className="text-13 text-ink-3">{d.detail}</span>
                        {WHAT[d.label] ? (
                          <span id={`demo-${d.label}-what`} className="mt-1.5 text-14 text-ink-2">
                            {WHAT[d.label]}
                          </span>
                        ) : null}
                      </span>
                      <span
                        aria-hidden="true"
                        className="col-start-2 mt-3 inline-flex items-center gap-1.5 text-14 font-medium text-ink group-hover:text-accent-ink sm:col-start-3 sm:row-start-1 sm:mt-0 sm:self-center"
                      >
                        Sign in
                        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                      </span>
                    </button>
                  </form>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-13 text-ink-3">
              Shown because this is a demo portal (<code className="font-mono text-12">SEED_CHECKER_SESSIONS=true</code>); a real
              event turns it off and this panel disappears.
            </p>
          </section>
        ) : null}
      </div>
    </PlainShell>
  );
}
