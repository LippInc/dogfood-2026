import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { demoSignIn } from "@/app/sign-in/actions";
import { demoIdentities, type DemoIdentity } from "@/server/dal";

/**
 * The front door for people trying the demo. It exists only while the portal runs in
 * demo mode (SEED_CHECKER_SESSIONS=true, where demoIdentities() is not empty); on a
 * real event's portal it renders nothing at all. One line under the status strip,
 * closed by default, so it never pushes a page down until someone asks for it.
 * Each step is one of the four ordinary demo sign-ins, landing where that role starts.
 */

/** What each demo identity shows, in the tour's order. */
export const DEMO_STEPS: { label: DemoIdentity["label"]; role: string; what: string }[] = [
  {
    label: "organizer",
    role: "Organizer",
    what: "The overview: three decisions stand between the scores and the results. Settle them, publish, and see how any score was worked out.",
  },
  {
    label: "judge_a",
    role: "Judge",
    what: "The keyboard-first console: keys 1 to 5, autosave, and your own ranking so far. Asking for another judge's scores is refused.",
  },
  {
    label: "participant",
    role: "Team member",
    what: "The gallery as a team member: My project holds the team's page, its reviews once published and its signed certificate.",
  },
];

export function DemoTour({ eventSlug }: { eventSlug: string }) {
  const people = demoIdentities();
  if (people.length === 0) return null;
  const steps = DEMO_STEPS.flatMap((s) => {
    const who = people.find((p) => p.label === s.label);
    return who ? [{ ...s, name: who.name }] : [];
  });
  return (
    <details className="group border-b border-rule bg-accent-tint print:hidden">
      <summary className="mx-auto flex max-w-[1440px] cursor-pointer list-none items-center gap-3 px-4 py-2 text-14 sm:px-8 xl:px-16 [&::-webkit-details-marker]:hidden">
        <span className="label-mono shrink-0 text-accent-ink">Demo portal</span>
        <span className="min-w-0 truncate text-ink">
          <span className="max-sm:hidden">Four one-click sign-ins show what it does. </span>Take the tour
        </span>
        <ChevronDown className="size-4 shrink-0 text-ink-2 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
      </summary>
      <div className="mx-auto max-w-[1440px] px-4 pb-6 pt-2 sm:px-8 xl:px-16">
        <ol className="grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-4">
          {steps.map((s, i) => (
            <li key={s.label} className="flex flex-col gap-2 border-t-2 border-ink pt-2">
              <p className="flex items-baseline gap-2">
                <span className="font-mono text-12 text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-15 font-semibold">{s.role}</span>
                <span className="truncate text-13 text-ink-2">{s.name}</span>
              </p>
              <p className="text-14 text-ink-2">{s.what}</p>
              <form action={demoSignIn} className="mt-auto">
                <input type="hidden" name="label" value={s.label} />
                <button className="h-10 rounded-sm border border-edge bg-surface px-4 text-14 font-medium hover:bg-raised">Sign in as {s.name}</button>
              </form>
            </li>
          ))}
          <li className="flex flex-col gap-2 border-t-2 border-ink pt-2">
            <p className="flex items-baseline gap-2">
              <span className="font-mono text-12 text-ink-3">{String(steps.length + 1).padStart(2, "0")}</span>
              <span className="text-15 font-semibold">Anyone</span>
            </p>
            <p className="text-14 text-ink-2">Once published: each place with its score&rsquo;s ±, and certificates anyone can check, even with one letter changed.</p>
            <p className="mt-auto flex flex-wrap gap-2">
              <Link href={`/events/${eventSlug}/results`} className="inline-flex h-10 items-center rounded-sm border border-edge bg-surface px-4 text-14 font-medium hover:bg-raised">
                Results
              </Link>
              <Link href="/verify" className="inline-flex h-10 items-center rounded-sm border border-edge bg-surface px-4 text-14 font-medium hover:bg-raised">
                Check a record
              </Link>
            </p>
          </li>
        </ol>
        <p className="mt-5 text-13 text-ink-2">
          Shown only while this portal runs with <code className="font-mono text-12">SEED_CHECKER_SESSIONS=true</code>. A real event&rsquo;s portal turns that off, and
          this strip and the demo sign-ins disappear.
        </p>
      </div>
    </details>
  );
}
