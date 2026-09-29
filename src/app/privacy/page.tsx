import type { Metadata } from "next";
import { PlainShell } from "@/components/shell/plain-shell";
import { KEPT, ticks } from "@/lib/privacy-facts";

export const metadata: Metadata = { title: "What we keep" };

/** A fact's cell: plain text with its `code` spans in mono. */
function Cell({ text }: { text: string }) {
  return (
    <>
      {ticks(text).map((part, i) =>
        i % 2 ? (
          <code key={i} className="font-mono text-13">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

const COOKIES = [
  { name: "session", body: "Keeps you signed in; the portal stores only a hash of it. Signing out deletes it." },
  { name: "vote_<event>", body: "Your ballot, when you vote through a voting link, so this browser gets the same ballot back." },
  { name: "mode", body: "Light or dark, when you pick one. It never reaches the database." },
];

/**
 * What the portal keeps about people, from the same list as DATA-MODEL.md (src/lib/privacy-facts.ts). The sign-up
 * form, the comment box and the voting-link page link here from their one-line notices.
 */
export default function PrivacyPage() {
  return (
    <PlainShell width="max-w-[1040px]">
      <p className="label-mono text-accent-ink">Your data on this portal</p>
      <h1 className="mt-3 font-display text-38">What we keep</h1>
      <p className="mt-3 max-w-[680px] text-15 text-ink-2">
        Everything this portal stores about the people who use it, how long it stays, and what removes it. &ldquo;We&rdquo; are the organizers who run it: ask
        them about anything here. There are no analytics or tracking scripts, and no raw network addresses are stored.
      </p>

      <ol className="mt-10 flex flex-col border-b border-rule">
        {KEPT.map((f) => (
          <li key={f.what} className="grid gap-x-8 gap-y-3 border-t border-rule py-5 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <p className="text-15 font-semibold">
                <Cell text={f.what} />
              </p>
              <p className="mt-1 text-13 text-ink-3 wrap-anywhere">
                <Cell text={f.where} />
              </p>
            </div>
            <dl className="contents">
              <div className="min-w-0">
                <dt className="label-mono text-ink-3">Kept</dt>
                <dd className="mt-1 text-14 text-ink-2">
                  <Cell text={f.kept} />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="label-mono text-ink-3">Removed by</dt>
                <dd className="mt-1 text-14 text-ink-2">
                  <Cell text={f.removedBy} />
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>

      <section aria-labelledby="cookies-title" className="mt-12 max-w-[680px]">
        <h2 id="cookies-title" className="text-20 font-semibold">
          Cookies
        </h2>
        <p className="mt-2 text-15 text-ink-2">Three, all the portal&rsquo;s own, none for tracking:</p>
        <dl className="mt-4 flex flex-col gap-3">
          {COOKIES.map((c) => (
            <div key={c.name} className="grid gap-x-4 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
              <dt className="font-mono text-13">{c.name}</dt>
              <dd className="text-14 text-ink-2">{c.body}</dd>
            </div>
          ))}
        </dl>
      </section>
    </PlainShell>
  );
}
