import type { Metadata } from "next";
import { forbidden, unauthorized } from "next/navigation";
import { RowsEditor } from "@/components/rows-editor";
import { SectionForm } from "@/components/section-form";
import { WorkShell } from "@/components/shell/work-shell";
import { UtcNow } from "@/components/utc-now";
import { currentActor } from "@/server/dal";
import { createEventAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New event" };

/** A field refused on save is marked aria-invalid by SectionForm: flag edge and bar, as on the settings page. */
const invalid = "aria-[invalid=true]:border-flag-bar aria-[invalid=true]:shadow-[inset_3px_0_0_var(--flag-bar)]";
const input = `h-8 w-full rounded-sm border border-edge bg-surface px-2.5 text-14 ${invalid}`;

/** Plain words for a refusal: each error is listed under what the organizer sees, not the field's key. */
const FIELD_LABELS = {
  details: "Name and dates",
  name: "Name",
  slug: "Web address",
  description: "Description",
  submissionsOpenAt: "Submissions open",
  submissionsCloseAt: "Submissions close",
  judgingCloseAt: "Judging closes",
  maxTeamSize: "Most people on one team",
  tracks: "Tracks",
  prizes: "Prizes",
};

export default async function NewEventPage() {
  const actor = await currentActor();
  if (!actor) unauthorized();
  if (!actor.isAdmin) forbidden();
  return (
    <WorkShell eventName="Dogfood portal" eventHref="/organize" crumb="New event" person={actor.name} role="Administrator">
      <div className="mx-auto flex max-w-[960px] flex-col gap-6">
        <div>
          <h1 className="text-24 font-semibold">New event</h1>
          <p className="mt-1 text-14 text-ink-2">
            You become its organizer. The rubric starts as functionality, quality and innovation with equal weights; change
            it in the event&apos;s settings. Times are in UTC.
          </p>
        </div>
        <SectionForm id="new-event" title="The event" action={createEventAction} submitLabel="Create event" fieldLabels={FIELD_LABELS}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-13 text-ink-2">
              Name
              <input name="name" required className={input} />
            </label>
            <label className="flex flex-col gap-1 text-13 text-ink-2">
              Web address (optional; made from the name)
              <input name="slug" placeholder="spring-hack-2027" className={`${input} font-mono`} />
            </label>
            <label className="flex flex-col gap-1 text-13 text-ink-2 sm:col-span-2">
              Description
              <textarea name="description" rows={3} className={`w-full rounded-sm border border-edge bg-surface px-2.5 py-2 font-serif text-15 ${invalid}`} />
            </label>
            <label className="flex flex-col gap-1 text-13 text-ink-2">
              Submissions open (UTC, empty = from now)
              <input type="datetime-local" name="submissionsOpenAt" className={input} />
            </label>
            <label className="flex flex-col gap-1 text-13 text-ink-2">
              Submissions close (UTC)
              <input type="datetime-local" name="submissionsCloseAt" required className={input} />
            </label>
            <label className="flex flex-col gap-1 text-13 text-ink-2">
              Judging closes (UTC, optional)
              <input type="datetime-local" name="judgingCloseAt" className={input} />
            </label>
            <label className="flex flex-col gap-1 text-13 text-ink-2">
              Most people on one team
              <input type="number" name="maxTeamSize" min={1} max={20} defaultValue={4} className={input} />
            </label>
          </div>
          <UtcNow />
          <div className="flex flex-col gap-3 border-t border-rule pt-5">
            <div>
              <h3 className="text-15 font-semibold">Tracks</h3>
              <p className="mt-0.5 text-13 text-ink-2">At least one. A team picks its track when it submits; the gallery shows projects by track.</p>
            </div>
            <RowsEditor
              name="tracks"
              initial={[]}
              blank={{ name: "" }}
              addLabel="Add a track"
              fields={[{ key: "name", label: "Track name", type: "text", placeholder: "Developer tools" }]}
              grid="lg:grid-cols-[20px_minmax(0,1fr)_92px]"
            />
          </div>
          <div className="flex flex-col gap-3 border-t border-rule pt-5">
            <div>
              <h3 className="text-15 font-semibold">Prizes</h3>
              <p className="mt-0.5 text-13 text-ink-2">Optional. A name and a line on what wins it, shown on the About page.</p>
            </div>
            <RowsEditor
              name="prizes"
              initial={[]}
              blank={{ name: "", description: "" }}
              addLabel="Add a prize"
              fields={[
                { key: "name", label: "Prize", type: "text", width: "w-56" },
                { key: "description", label: "What wins it", type: "text" },
              ]}
              grid="lg:grid-cols-[20px_minmax(0,14rem)_minmax(0,1fr)_92px]"
            />
          </div>
        </SectionForm>
      </div>
    </WorkShell>
  );
}
