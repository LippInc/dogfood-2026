import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { RowsEditor } from "@/components/rows-editor";
import { SectionForm } from "@/components/section-form";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { UtcNow } from "@/components/utc-now";
import { guardPage, utcInput } from "@/lib/page-guard";
import { formatUtc } from "@/lib/format";
import { currentActor, getOrganizerEvent, listOrganizers } from "@/server/dal";
import { addOrganizerAction, savePrizesAction, saveQuestionsAction, saveRubricAction, saveDetailsAction, saveTracksAction } from "./actions";
import { RemoveOrganizer } from "./remove-organizer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

const input = "h-8 w-full rounded-sm border border-edge bg-surface px-2.5 text-14";

export default async function SettingsPage({ params }: PageProps<"/organize/[event]/settings">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const o = guardPage(() => getOrganizerEvent(actor, key));
  const { event } = o;
  const organizers = listOrganizers(actor, event.id);
  const hidden = { event: event.slug };
  const totalWeight = o.rubric.reduce((s, c) => s + c.weight, 0);
  return (
    <WorkShell
      eventName={event.name}
      eventHref={`/organize/${event.slug}`}
      tabs={organizerTabs(event.slug, "Settings")}
      person={actor.name}
      role="Organizer"
    >
      <div className="mx-auto flex max-w-[960px] flex-col gap-6">
        <div>
          <h1 className="text-24 font-semibold">Settings</h1>
          <p className="mt-1 text-14 text-ink-2">
            Every save is written to the audit log with what it changed. Times are in UTC.
          </p>
        </div>

        <SectionForm
          id="details"
          title="Event"
          description={event.resultsPublishedAt ? "Results are published, so the dates are final; the name, description and team size can still change." : undefined}
          action={saveDetailsAction}
          hidden={hidden}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-13 text-ink-2 sm:col-span-2">
              Name
              <input name="name" defaultValue={event.name} className={input} />
            </label>
            <label className="flex flex-col gap-1 text-13 text-ink-2 sm:col-span-2">
              Description (shown on the About page)
              <textarea name="description" defaultValue={event.description} rows={4} className="w-full rounded-sm border border-edge bg-surface px-2.5 py-2 font-serif text-15" />
            </label>
            <label className="flex flex-col gap-1 text-13 text-ink-2">
              Submissions open (UTC, empty = from now)
              <input type="datetime-local" name="submissionsOpenAt" defaultValue={utcInput(event.submissionsOpenAt)} className={input} />
            </label>
            <label className="flex flex-col gap-1 text-13 text-ink-2">
              Submissions close (UTC)
              <input type="datetime-local" name="submissionsCloseAt" defaultValue={utcInput(event.submissionsCloseAt)} className={input} />
            </label>
            <label className="flex flex-col gap-1 text-13 text-ink-2">
              Judging closes (UTC, optional)
              <input type="datetime-local" name="judgingCloseAt" defaultValue={utcInput(event.judgingCloseAt)} className={input} />
            </label>
            <label className="flex flex-col gap-1 text-13 text-ink-2">
              Most people on one team
              <input type="number" name="maxTeamSize" min={1} max={20} defaultValue={event.settings.maxTeamSize ?? 4} className={input} />
            </label>
          </div>
          <UtcNow />
        </SectionForm>

        <SectionForm
          id="organizers"
          title="Organizers"
          description="Everyone here can change this event, settle its decisions and publish its results. Add someone by the email of their account: they sign up first, since the portal sends no mail. The last organizer cannot be removed."
          action={addOrganizerAction}
          hidden={hidden}
          submitLabel="Add organizer"
          resetOnSuccess
          before={
            <ul className="divide-y divide-rule rounded-sm border border-rule">
              {organizers.map((g) => (
                <li key={g.userId} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block text-14 font-medium">
                      {g.name}
                      {g.userId === actor.userId ? <span className="ml-2 text-12 font-normal text-ink-2">you</span> : null}
                    </span>
                    <span className="block truncate text-13 text-ink-2">
                      {g.email} · since {formatUtc(g.since)}
                    </span>
                  </span>
                  {organizers.length > 1 ? <RemoveOrganizer eventSlug={event.slug} userId={g.userId} name={g.name} /> : null}
                </li>
              ))}
            </ul>
          }
        >
          <label className="flex flex-col gap-1 text-13 text-ink-2 sm:max-w-[420px]">
            Email of their account
            <input name="email" type="email" autoComplete="off" className={input} />
          </label>
        </SectionForm>

        <SectionForm
          id="tracks"
          title="Tracks"
          description="Projects enter one track; judges are assigned by track. A track that has projects or judges can be renamed, not removed."
          action={saveTracksAction}
          hidden={hidden}
        >
          <RowsEditor
            name="tracks"
            initial={o.tracks.map((t) => ({ id: t.id, name: t.name }))}
            blank={{ name: "" }}
            addLabel="Add a track"
            fields={[{ key: "name", label: "Track name", type: "text" }]}
          />
        </SectionForm>

        <SectionForm id="prizes" title="Prizes" description="A name and a line on what wins it. Shown on the About page." action={savePrizesAction} hidden={hidden}>
          <RowsEditor
            name="prizes"
            initial={o.prizes.map((p) => ({ id: p.id, name: p.name, description: p.description }))}
            blank={{ name: "", description: "" }}
            addLabel="Add a prize"
            fields={[
              { key: "name", label: "Prize", type: "text", width: "w-56" },
              { key: "description", label: "What wins it", type: "text" },
            ]}
          />
        </SectionForm>

        <SectionForm
          id="questions"
          title="Questions for teams"
          description="Asked on every team's project form; judges read the answers next to the project. A required question must be answered before a team can submit."
          action={saveQuestionsAction}
          hidden={hidden}
        >
          <RowsEditor
            name="questions"
            initial={o.questions.map((q) => ({ id: q.id, label: q.label, help: q.help, type: q.type, required: q.required }))}
            blank={{ label: "", help: "", type: "longtext", required: false }}
            addLabel="Add a question"
            fields={[
              { key: "label", label: "Question", type: "text" },
              { key: "help", label: "Hint for teams", type: "text" },
              {
                key: "type",
                label: "Answer",
                type: "select",
                width: "w-32",
                options: [
                  { value: "longtext", label: "Paragraph" },
                  { value: "text", label: "One line" },
                  { value: "url", label: "Link" },
                ],
              },
              { key: "required", label: "Required", type: "checkbox" },
            ]}
          />
        </SectionForm>

        <SectionForm
          id="rubric"
          title="Scoring rubric"
          description={
            <>
              Judges score each criterion from 1 to 5; a review&apos;s total is the weighted mean. Weights are relative: 1, 1
              and 2 give the last criterion half the total. Now:{" "}
              {o.rubric.map((c, i) => (
                <span key={c.id} className="tnum">
                  {i ? " · " : ""}
                  {c.label} {Math.round((c.weight / totalWeight) * 100)} %
                </span>
              ))}
              .{event.resultsPublishedAt ? " Results are published, so the rubric is final." : ""}
            </>
          }
          action={saveRubricAction}
          hidden={hidden}
        >
          <RowsEditor
            name="rubric"
            initial={o.rubric.map((c) => ({ id: c.id, label: c.label, prompt: c.prompt, weight: c.weight }))}
            blank={{ label: "", prompt: "", weight: 1 }}
            addLabel="Add a criterion"
            locked={o.scored}
            lockedHint="Judges have scored already: labels, prompts and weights can change, the set of criteria cannot."
            fields={[
              { key: "label", label: "Criterion", type: "text", width: "w-40" },
              { key: "prompt", label: "Question for the judge", type: "text" },
              { key: "weight", label: "Weight", type: "number", width: "w-20" },
            ]}
          />
        </SectionForm>
      </div>
    </WorkShell>
  );
}
