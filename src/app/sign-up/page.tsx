import type { Metadata } from "next";
import Link from "next/link";
import { PlainShell } from "@/components/shell/plain-shell";
import { SignUpForm } from "./sign-up-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create an account" };

/** What comes after the account: the ways to a role, or, on the setup link, the administrator's first steps. */
const ROLES = [
  { head: "Start a team", body: "On an event's My project page. You become its captain and get an invite link to share." },
  { head: "Join a team", body: "Open the invite link your captain sends. You edit the team's project with them." },
  { head: "Judge", body: "Open the judge invitation an organizer sends. You score the projects assigned to you." },
];
const SETUP = [
  { head: "Sign up here", body: "This link is the only way to an administrator account, and it works once." },
  { head: "Add an event", body: "Create one, or import one from a file." },
  { head: "Bring people in", body: "Send judge invitations; teams start themselves from the event's pages." },
];

export default async function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : null;
  const setup = typeof sp.setup === "string" && sp.setup.length <= 200 ? sp.setup : null;
  const steps = setup ? SETUP : ROLES;
  return (
    <PlainShell width="max-w-[1040px]">
      <div className="grid gap-12 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] md:gap-16">
        <section aria-labelledby="signup-title">
          {setup ? <p className="label-mono mb-3 text-accent-ink">Administrator setup · one-time link</p> : null}
          <h1 id="signup-title" className="font-display text-38">
            Create an account
          </h1>
          <p className="mt-2 text-15 text-ink-2">
            {setup
              ? "This account will administer the portal: it creates events, or imports them from a file."
              : "An account on its own can comment on projects, and vote where an event lets accounts vote; for more, you get a role by starting or joining a team, or when an organizer invites you to judge."}
          </p>
          <div className="mt-8">
            <SignUpForm next={next} setup={setup} />
          </div>
          <p className="mt-6 text-14 text-ink-2">
            Already have an account?{" "}
            <Link href={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"} className="underline decoration-edge underline-offset-4 hover:decoration-ink">
              Sign in
            </Link>
          </p>
        </section>
        <aside aria-labelledby="after-title" className="self-start md:mt-[4.5rem]">
          <h2 id="after-title" className="label-mono text-ink-3">
            {setup ? "The first three steps" : "Then, one of three ways in"}
          </h2>
          <ol className="mt-4 flex flex-col gap-6">
            {steps.map((s, i) => (
              <li key={s.head} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 border-t-2 border-ink pt-3">
                <span className="font-mono text-12 text-ink-3 tnum">{String(i + 1).padStart(2, "0")}</span>
                <span className="flex flex-col gap-1">
                  <span className="text-15 font-semibold">{s.head}</span>
                  <span className="text-14 text-ink-2">{s.body}</span>
                </span>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </PlainShell>
  );
}
