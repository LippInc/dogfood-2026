import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { SectionForm } from "@/components/section-form";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { formatUtc, plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getUpdatesAdmin, UPDATE_BODY_MAX, UPDATE_TITLE_MAX } from "@/server/dal";
import { postUpdateAction } from "./actions";
import { BODY_INPUT, EditUpdate, RemoveUpdate, TITLE_INPUT } from "./forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Updates" };

const invalid = "aria-[invalid=true]:border-flag-bar aria-[invalid=true]:shadow-[inset_3px_0_0_var(--flag-bar)]";

/** The organizers' news to everyone following the event: write one, and edit or remove what was posted. */
export default async function UpdatesAdminPage({ params }: PageProps<"/organize/[event]/updates">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, updates, emailOn, recipients } = guardPage(() => getUpdatesAdmin(actor, key));
  return (
    <WorkShell eventName={event.name} eventHref={`/organize/${event.slug}`} tabs={organizerTabs(event.slug, "Updates")} person={actor.name} role="Organizer">
      <div className="mx-auto flex max-w-[960px] flex-col gap-6">
        <div>
          <h1 className="text-24 font-semibold">Updates</h1>
          <p className="mt-1 max-w-[720px] text-14 text-ink-2">
            News for everyone following the event: a deadline moved, judging has started, winners at 18:00. The newest three show on the event&apos;s
            Projects and About pages, all of them on{" "}
            <a href={`/events/${event.slug}/updates`} className="underline underline-offset-2 hover:text-ink">
              its Updates page
            </a>
            . Updates are news, not results, so they can be posted, edited and removed after publishing too. Every post, edit and removal is in the audit log with
            its words.
          </p>
        </div>

        <SectionForm
          id="new-update"
          title="Post an update"
          action={postUpdateAction}
          hidden={{ event: event.slug }}
          submitLabel="Post the update"
          resetOnSuccess
          fieldLabels={{ title: "Title", body: "The update", email: "Email" }}
        >
          <label className="flex flex-col gap-1 text-13 text-ink-2">
            Title
            <input name="title" maxLength={UPDATE_TITLE_MAX} autoComplete="off" className={`${TITLE_INPUT} ${invalid}`} />
          </label>
          <label className="flex flex-col gap-1 text-13 text-ink-2">
            The update (plain text; line breaks are kept, and a web address shows as text)
            <textarea name="body" rows={6} maxLength={UPDATE_BODY_MAX} className={`${BODY_INPUT} ${invalid}`} />
          </label>
          {emailOn ? (
            recipients ? (
              <label className="flex items-start gap-2 text-14">
                <input type="checkbox" name="email" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
                <span>
                  Also mail it to the {plural(recipients, "participant")} of this event
                  <span className="block text-12 text-ink-3">Everyone on a team, once each. The outbox on the Integrations page shows each message.</span>
                </span>
              </label>
            ) : (
              <p className="text-13 text-ink-3">Nobody is on a team yet, so there is no participant to mail it to.</p>
            )
          ) : (
            <p className="text-13 text-ink-3">Email is off on this portal (SMTP_URL is not set): the update shows on the event&apos;s pages only.</p>
          )}
        </SectionForm>

        <section aria-labelledby="posted-title" className="flex flex-col gap-3">
          <h2 id="posted-title" className="text-17 font-semibold">
            Posted <span className="tnum text-14 font-normal text-ink-2">{updates.length}</span>
          </h2>
          {updates.length ? (
            <ol className="divide-y divide-rule rounded-sm border border-rule bg-surface">
              {updates.map((u) => (
                <li key={u.id} className="flex flex-col gap-2 px-4 py-4 sm:px-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="label-mono tnum text-ink-3">
                        {formatUtc(u.at)}
                        {u.editedAt ? ` · edited ${formatUtc(u.editedAt)}` : ""}
                      </p>
                      <h3 className="mt-1 text-15 font-semibold wrap-anywhere">{u.title}</h3>
                    </div>
                    <RemoveUpdate eventSlug={event.slug} id={u.id} title={u.title} />
                  </div>
                  <p className="max-w-[680px] font-serif text-15 leading-6 whitespace-pre-line text-ink-2 wrap-anywhere">{u.body}</p>
                  <EditUpdate eventSlug={event.slug} id={u.id} title={u.title} body={u.body} titleMax={UPDATE_TITLE_MAX} bodyMax={UPDATE_BODY_MAX} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="rounded-sm border border-dashed border-edge px-5 py-6 text-14 text-ink-2">No update yet. What you post shows on the event&apos;s public pages at once.</p>
          )}
        </section>
      </div>
    </WorkShell>
  );
}
