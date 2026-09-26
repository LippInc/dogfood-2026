import type { Metadata } from "next";
import { forbidden, unauthorized } from "next/navigation";
import { RowsEditor } from "@/components/rows-editor";
import { SectionForm } from "@/components/section-form";
import { WorkShell } from "@/components/shell/work-shell";
import { currentActor } from "@/server/dal";
import { createEventAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New event" };

const input = "h-8 w-full rounded-sm border border-edge bg-surface px-2.5 text-14";

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
        <SectionForm id="new-event" title="The event" action={createEventAction} submitLabel="Create event">
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
              <textarea name="description" rows={3} className="w-full rounded-sm border border-edge bg-surface px-2.5 py-2 font-serif text-15" />
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
          <div className="flex flex-col gap-2">
            <p className="text-14 font-medium">Tracks</p>
            <RowsEditor name="tracks" initial={[]} blank={{ name: "" }} addLabel="Add a track" fields={[{ key: "name", label: "Track name", type: "text" }]} />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-14 font-medium">Prizes</p>
            <RowsEditor
              name="prizes"
              initial={[]}
              blank={{ name: "", description: "" }}
              addLabel="Add a prize"
              fields={[
                { key: "name", label: "Prize", type: "text", width: "w-56" },
                { key: "description", label: "What wins it", type: "text" },
              ]}
            />
          </div>
        </SectionForm>
      </div>
    </WorkShell>
  );
}
