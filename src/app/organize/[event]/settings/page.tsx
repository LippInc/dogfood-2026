import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { RowsEditor } from "@/components/rows-editor";
import { SectionForm } from "@/components/section-form";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { UtcNow } from "@/components/utc-now";
import { guardPage, utcInput } from "@/lib/page-guard";
import { formatUtc } from "@/lib/format";
import { FIELD_LABELS, PROJECT_FIELDS } from "@/lib/project-fields";
import { currentActor, getOrganizerEvent, getPrizeAwards, judgingModeOf, listOrganizers } from "@/server/dal";
import {
  addOrganizerAction,
  saveDetailsAction,
  saveJudgingModeAction,
  savePrizesAction,
  saveProjectFieldsAction,
  saveQuestionsAction,
  saveRubricAction,
  saveTieBreakAction,
  saveTracksAction,
} from "./actions";
import { RemoveOrganizer } from "./remove-organizer";
import { DateField } from "./date-field";
import { ProjectFieldsEditor } from "./project-fields-editor";
import { RubricEditor } from "./rubric-editor";
import { type ContentsEntry, SettingsContents } from "./settings-contents";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

/** A field refused on save is marked aria-invalid by SectionForm: flag edge and bar, like the error list under it. */
const invalid = "aria-[invalid=true]:border-flag-bar aria-[invalid=true]:shadow-[inset_3px_0_0_var(--flag-bar)]";
const input = `h-8 w-full rounded-sm border border-edge bg-surface px-2.5 text-14 ${invalid}`;

const num = (i: number) => String(i + 1).padStart(2, "0");

/** The sections in page order, for the contents rail: [SectionForm id, title]. */
const SECTIONS: [string, string][] = [
  ["details", "Event"],
  ["organizers", "Organizers"],
  ["tracks", "Tracks"],
  ["prizes", "Prizes"],
  ["project-fields", "What teams fill in"],
  ["questions", "Questions for teams"],
  ["judging-mode", "How judges judge"],
  ["rubric", "Scoring rubric"],
  ["tie-break", "Exact ties"],
];

export default async function SettingsPage({ params }: PageProps<"/organize/[event]/settings">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const o = guardPage(() => getOrganizerEvent(actor, key));
  const { event } = o;
  const organizers = listOrganizers(actor, event.id);
  const hidden = { event: event.slug };
  const mode = judgingModeOf(event);
  const count = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : "none");
  const hiddenCount = PROJECT_FIELDS.filter((f) => o.fields[f] === "hidden").length;
  // the prizes given so far: before publishing each is named, since removing its prize takes the award back; once
  // published with any given, the prize list is final (the database's prizes_final_* triggers refuse a change)
  const awarded = o.prizes.length ? guardPage(() => getPrizeAwards(actor, key)).prizes.filter((p) => p.winners.length) : [];
  // the same list savePrizes and the prizes_final triggers read: the stored awards
  const prizesFinal = Boolean(event.resultsPublishedAt) && (event.settings.prizeAwards?.length ?? 0) > 0;
  // the criterion that breaks exact ties, when one is set and the event judges by scores (pairwise has no criteria)
  const tieId = mode === "scores" ? (event.settings.tieBreak?.criterionId ?? null) : null;
  const tieLabel = o.rubric.find((c) => c.id === tieId)?.label ?? null;
  /** What each section holds now, from the saved event: the contents read as an index, not only a list of names. */
  const holds: Record<string, string> = {
    details: event.resultsPublishedAt ? "dates final" : "",
    organizers: String(organizers.length),
    tracks: String(o.tracks.length),
    prizes: o.prizes.length ? String(o.prizes.length) : "none",
    // how many of the form's own fields a team is asked, as Tracks shows how many tracks
    "project-fields": String(PROJECT_FIELDS.length - hiddenCount),
    questions: o.questions.length ? String(o.questions.length) : "none",
    "judging-mode": mode === "pairwise" ? "Pairwise" : "Scores",
    rubric: count(o.rubric.length, "criterion", "criteria"),
    "tie-break": tieLabel ?? "Joint",
  };
  const contents: ContentsEntry[] = SECTIONS.map(([id, title], i) => ({ id, num: num(i), title, holds: holds[id] }));
  return (
    <WorkShell
      eventName={event.name}
      eventHref={`/organize/${event.slug}`}
      tabs={organizerTabs(event.slug, "Settings")}
      person={actor.name}
      role="Organizer"
    >
      <div className="mx-auto max-w-[960px] lg:grid lg:max-w-[1200px] lg:grid-cols-[200px_minmax(0,960px)] lg:gap-10">
        {/* the sheet's contents: one numbered line per section with what it holds now, kept in view while the long form scrolls */}
        <SettingsContents variant="rail" entries={contents} />
        <div className="flex min-w-0 flex-col gap-6">
          <div>
            <h1 className="text-24 font-semibold">Settings</h1>
            <p className="mt-1 text-14 text-ink-2">
              Every save is written to the audit log with what it changed. Times are in UTC. News for everyone following the event
              goes on{" "}
              <a href={`/organize/${event.slug}/updates`} className="underline underline-offset-2 hover:text-ink">
                the Updates page
              </a>
              .
            </p>
          </div>
          {/* on phones the form is five screens long: the same contents, as a two-column index under the heading */}
          <SettingsContents variant="index" entries={contents} />

          <SectionForm
            id="details"
            markUnsaved
            number={num(0)}
            title="Event"
            description={
              event.resultsPublishedAt ? "Results are published, so the dates and the certificate places are final; the name, description and team size can still change." : undefined
            }
            action={saveDetailsAction}
            hidden={hidden}
            fieldLabels={{
              name: "Name",
              description: "Description",
              submissionsOpenAt: "Submissions open",
              submissionsCloseAt: "Submissions close",
              judgingCloseAt: "Judging closes",
              maxTeamSize: "Most people on one team",
              certificatePlaces: "Places that earn a certificate",
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-13 text-ink-2 sm:col-span-2">
                Name
                <input name="name" defaultValue={event.name} className={input} />
              </label>
              <label className="flex flex-col gap-1 text-13 text-ink-2 sm:col-span-2">
                Description (shown on the About page)
                <textarea name="description" defaultValue={event.description} rows={4} className={`w-full rounded-sm border border-edge bg-surface px-2.5 py-2 font-serif text-15 ${invalid}`} />
              </label>
              <DateField label="Submissions open (UTC)" name="submissionsOpenAt" value={utcInput(event.submissionsOpenAt)} empty="Empty: no opening time, open until the close" className={input} />
              <DateField label="Submissions close (UTC)" name="submissionsCloseAt" value={utcInput(event.submissionsCloseAt)} empty="Required" className={input} />
              <DateField label="Judging closes (UTC)" name="judgingCloseAt" value={utcInput(event.judgingCloseAt)} empty="Empty: judging has no closing time" className={input} />
              <label className="flex flex-col gap-1 text-13 text-ink-2">
                Most people on one team
                <input type="number" name="maxTeamSize" min={1} max={20} defaultValue={event.settings.maxTeamSize ?? 4} className={input} />
                <span className="text-12 text-ink-3">1: everyone takes part alone, under their own name, with no team to form or invite to.</span>
              </label>
              <label className="flex flex-col gap-1 text-13 text-ink-2">
                Places in each track that earn a certificate of achievement
                <input
                  type="number"
                  name="certificatePlaces"
                  min={1}
                  max={20}
                  defaultValue={event.settings.certificatePlaces ?? 3}
                  readOnly={Boolean(event.resultsPublishedAt)}
                  aria-describedby="certificate-places-help"
                  className={input}
                />
                <span id="certificate-places-help" className="text-12 text-ink-3">
                  {event.resultsPublishedAt ? "Fixed: certificates are signed from publishing on." : "The rest get a certificate of participation. Fixed once results are published."}
                </span>
              </label>
            </div>
            <UtcNow />
          </SectionForm>

          <SectionForm
            id="organizers"
            number={num(1)}
            title="Organizers"
            description="Everyone here can change this event, settle its decisions and publish its results. Add someone by the email of their account, once they have signed up: adding an organizer mails nothing. The last organizer cannot be removed."
            action={addOrganizerAction}
            hidden={hidden}
            submitLabel="Add organizer"
            resetOnSuccess
            fieldLabels={{ email: "Email" }}
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
            markUnsaved
            number={num(2)}
            title="Tracks"
            description={
              event.resultsPublishedAt
                ? "Results are published, so the tracks are final: the results are grouped, ordered and named by them."
                : "Projects enter one track; judges are assigned by track. A track that has projects or judges can be renamed, not removed."
            }
            action={saveTracksAction}
            hidden={hidden}
            fieldLabels={{ tracks: "Tracks" }}
            rowLabel="Track"
          >
            <RowsEditor
              name="tracks"
              initial={o.tracks.map((t) => ({ id: t.id, name: t.name }))}
              blank={{ name: "" }}
              addLabel="Add a track"
              disabled={Boolean(event.resultsPublishedAt)}
              grid="lg:grid-cols-[20px_minmax(0,1fr)_92px]"
              fields={[{ key: "name", label: "Track name", type: "text" }]}
            />
          </SectionForm>

          <SectionForm
            id="prizes"
            markUnsaved
            number={num(3)}
            title="Prizes"
            description={
              prizesFinal
                ? "Results are published with prizes awarded, so the prizes are final: each award names its prize."
                : "A name and a line on what wins it. Shown on the About page."
            }
            action={savePrizesAction}
            hidden={hidden}
            fieldLabels={{ prizes: "Prizes" }}
            rowLabel="Prize"
            before={
              !event.resultsPublishedAt && awarded.length ? (
                <ul aria-label="Prizes awarded" className="flex flex-col gap-1 border-l-[3px] border-rule pl-3 text-13 text-ink-2">
                  {awarded.map((p) => (
                    <li key={p.prizeId} className="wrap-anywhere">
                      {p.name} is awarded to {p.winners.map((w) => w.title).join(" and ")}; removing the prize takes the award back (the audit log keeps it).
                    </li>
                  ))}
                </ul>
              ) : undefined
            }
          >
            <RowsEditor
              name="prizes"
              initial={o.prizes.map((p) => ({ id: p.id, name: p.name, description: p.description }))}
              blank={{ name: "", description: "" }}
              addLabel="Add a prize"
              disabled={prizesFinal}
              grid="lg:grid-cols-[20px_minmax(0,14rem)_minmax(0,1fr)_92px]"
              fields={[
                { key: "name", label: "Prize", type: "text", width: "w-56" },
                { key: "description", label: "What wins it", type: "text" },
              ]}
            />
          </SectionForm>

          <SectionForm
            id="project-fields"
            markUnsaved
            number={num(4)}
            title="What teams fill in"
            description="The project form's own fields. Required ones must be filled before a team can submit (a required title or track on every save); optional ones may stay empty; hidden ones are not asked and not shown anywhere. Keep only what this event needs: when every team builds the same thing, a repository link may be all you need."
            action={saveProjectFieldsAction}
            hidden={hidden}
            submitLabel="Save the project form"
            fieldLabels={Object.fromEntries(PROJECT_FIELDS.map((f) => [f, FIELD_LABELS[f]]))}
          >
            <ProjectFieldsEditor saved={o.fields} tracks={o.tracks.length} questions={o.questions.length} />
          </SectionForm>

          <SectionForm
            id="questions"
            markUnsaved
            number={num(5)}
            title="Questions for teams"
            description="Your own questions, asked on every team's project form after the fields above; judges read the answers next to the project. A required question must be answered before a team can submit."
            action={saveQuestionsAction}
            hidden={hidden}
            fieldLabels={{ questions: "Questions" }}
            rowLabel="Question"
          >
            <RowsEditor
              name="questions"
              initial={o.questions.map((q) => ({ id: q.id, label: q.label, help: q.help, type: q.type, required: q.required }))}
              blank={{ label: "", help: "", type: "longtext", required: false }}
              addLabel="Add a question"
              grid="lg:grid-cols-[20px_minmax(0,1fr)_minmax(0,1fr)_8rem_5.5rem_92px]"
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
            id="judging-mode"
            markUnsaved
            number={num(6)}
            title="How judges judge"
            description={
              event.resultsPublishedAt
                ? "Results are published, so the way this event was judged is final."
                : "Either way every judge sees only the projects they were given, and the scores or answers already given stay. Scores given before a switch to pairwise still count, as the order they imply. The switch is written to the audit log with your reason."
            }
            action={saveJudgingModeAction}
            hidden={hidden}
            submitLabel="Save how judges judge"
            fieldLabels={{ mode: "Judging mode", reason: "Why", show: "Judges' own ranking" }}
          >
            <fieldset className="flex flex-col gap-2" disabled={Boolean(event.resultsPublishedAt)}>
              <legend className="sr-only">Judging mode</legend>
              {(
                [
                  ["scores", "Scores", "Each judge scores every project of theirs on the rubric below; the portal evens out harsh and lenient judges."],
                  ["pairwise", "Pairwise", "Each judge answers “which is better?” for two of their projects at a time; the portal ranks projects from every answer."],
                ] as const
              ).map(([value, label, help]) => (
                <label key={value} className="flex items-start gap-3 rounded-sm border border-edge px-3 py-2.5 has-[:checked]:border-accent has-[:checked]:bg-accent-tint">
                  <input type="radio" name="mode" value={value} defaultChecked={mode === value} className="mt-1 size-4 accent-[var(--primary)]" />
                  <span>
                    <span className="block text-14 font-medium">{label}</span>
                    <span className="block text-13 text-ink-2">{help}</span>
                  </span>
                </label>
              ))}
              <label className="mt-2 flex flex-col gap-1 text-13 text-ink-2">
                Why, when you switch (kept in the audit log)
                <input name="reason" maxLength={500} className={input} />
              </label>
              <label className="mt-3 flex items-start gap-3 border-t border-rule pt-4">
                <input
                  type="checkbox"
                  name="judgeRanking"
                  defaultChecked={event.settings.judgeRanking !== false}
                  className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
                />
                <span>
                  <span className="block text-14 font-medium">Show each judge their own ranking so far</span>
                  <span className="block text-13 text-ink-2">
                    The console lists the judge&apos;s finished reviews in the order of their own totals, and marks how often they have used each score. Turn it
                    off if you want judges to score each project against the rubric, not against the projects they saw before it.
                  </span>
                </span>
              </label>
            </fieldset>
          </SectionForm>

          <SectionForm
            id="rubric"
            markUnsaved
            number={num(7)}
            title="Scoring rubric"
            description={
              <>
                Judges score each criterion from 1 to 5; a review&apos;s total is the weighted mean. Weights are relative: 1, 1
                and 2 give the last criterion half the total.
                {event.resultsPublishedAt ? " Results are published, so the rubric is final." : ""}
              </>
            }
            action={saveRubricAction}
            hidden={hidden}
            fieldLabels={{ criteria: "Criteria", reason: "Reason" }}
            rowLabel="Criterion"
          >
            <RubricEditor
              saved={o.rubric.map((c) => ({ id: c.id, label: c.label, prompt: c.prompt, weight: c.weight }))}
              locked={o.scored}
              lockedHint="Judges have scored already: the set of criteria is fixed. Labels and prompts can change; a weight change needs a reason and shows on the published results."
              changes={event.settings.weightChanges ?? []}
            />
          </SectionForm>

          <SectionForm
            id="tie-break"
            markUnsaved
            number={num(8)}
            title="Exact ties"
            description={
              event.resultsPublishedAt
                ? "Results are published, so how ties were broken is final."
                : mode === "pairwise"
                  ? "This event judges pairwise, which has no rubric criteria to break a tie by: projects with exactly the same win % keep a joint place."
                  : "Projects in one track with exactly the same score share a place (“Joint 2nd”). Choose a criterion to order them instead: the higher average on it places first, and the results, certificates and normalized.csv say “tie broken by” it. Projects tied on that criterion too stay joint. Best chosen before judging: a change after the first score needs a reason, and the published results show it."
            }
            action={saveTieBreakAction}
            hidden={hidden}
            submitLabel="Save how ties are broken"
            fieldLabels={{ criterionId: "Break exact ties by", reason: "Why" }}
          >
            <fieldset className="flex flex-col gap-2" disabled={Boolean(event.resultsPublishedAt) || mode === "pairwise"}>
              <legend className="mb-1 text-13 text-ink-2">Break exact ties by</legend>
              {[{ id: "", label: "Keep joint places", help: "Tied projects share the place, as the scores have it. The default." }, ...o.rubric.map((c) => ({ id: c.id, label: c.label, help: `The higher plain average on ${c.label} over the reviews the ranking counts places first.` }))].map((c) => (
                <label key={c.id || "joint"} className="flex items-start gap-3 rounded-sm border border-edge px-3 py-2.5 has-[:checked]:border-accent has-[:checked]:bg-accent-tint">
                  <input type="radio" name="criterionId" value={c.id} defaultChecked={(tieId ?? "") === c.id || (c.id === "" && !tieLabel)} className="mt-1 size-4 accent-[var(--primary)]" />
                  <span className="min-w-0">
                    <span className="block text-14 font-medium wrap-anywhere">{c.label}</span>
                    <span className="block text-13 text-ink-2">{c.help}</span>
                  </span>
                </label>
              ))}
              {o.scored ? (
                <label className="mt-2 flex flex-col gap-1 text-13 text-ink-2">
                  Why, when you change it (judges have scored: the published results show it)
                  <input name="reason" maxLength={500} className={input} />
                </label>
              ) : null}
            </fieldset>
          </SectionForm>
        </div>
      </div>
    </WorkShell>
  );
}
