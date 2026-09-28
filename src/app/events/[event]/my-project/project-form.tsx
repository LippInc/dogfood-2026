"use client";

import { Check, Circle, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useFormAction } from "@/components/use-form-action";
import { FIELD_LABELS, PROJECT_FIELDS, type FieldModes, type ProjectField } from "@/lib/project-fields";
import type { ActionResult, Question } from "@/server/dal";
import { saveProjectAction } from "./actions";
import { PictureField } from "./picture-field";

/** The labels a refused save names, for the fields a person sees on this form. */
const LABELS: Record<string, string> = FIELD_LABELS;

export type FormProject = {
  id: string;
  title: string;
  summary: string;
  description: string;
  trackId: string;
  repoUrl: string | null;
  videoUrl: string | null;
  liveUrl: string | null;
  thumbnailUrl: string | null;
  galleryUrls: string[];
  tags: string[];
  status: "draft" | "submitted";
  answers: Record<string, string>;
};

type Needed = { key: string; label: string; done: boolean };

/** A numbered part of the form, in the drawing's voice: "02 · Links". */
function Part({ no, title, children }: { no: string; title: string; children: React.ReactNode }) {
  const id = `part-${no}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-5 border-t border-rule pt-5">
      <h2 id={id} className="flex items-baseline gap-3">
        <span className="font-mono text-12 text-accent-ink tnum">{no}</span>
        <span className="label-mono text-ink-2">{title}</span>
      </h2>
      {children}
    </section>
  );
}

/** What each built-in field holds when the form first draws, as the form would send it. */
function initialValue(field: ProjectField, p: FormProject | null, onlyTrack: string): string {
  if (field === "trackId") return p?.trackId ?? onlyTrack;
  if (!p) return "";
  const v = p[field];
  return Array.isArray(v) ? v.join(",") : (v ?? "");
}

/** The fields a submission still needs: the ones the organizers made required, then their required questions. */
function needed(form: HTMLFormElement | null, questions: Question[], fields: FieldModes, initial: FormProject | null, onlyTrack: string): Needed[] {
  const value = (name: string, fallback: string) =>
    form ? String((form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "").trim() : fallback.trim();
  return [
    ...PROJECT_FIELDS.filter((f) => fields[f] === "required").map((f) => ({
      key: f,
      label: FIELD_LABELS[f],
      done: Boolean(value(f, initialValue(f, initial, onlyTrack))),
    })),
    ...questions
      .filter((q) => q.required)
      .map((q) => ({ key: q.id, label: q.label, done: Boolean(value(`answer:${q.id}`, initial?.answers[q.id] ?? "")) })),
  ];
}

/** Links side by side on a wide screen, as many columns as there are links. */
const LINK_COLUMNS = ["", "", "sm:grid-cols-2", "sm:grid-cols-3"];

/**
 * The team's project: a draft until they submit, editable by any member until
 * submissions close. The side column lists what a submission still needs, the
 * deadline in UTC and local time, and the team. Which built-in fields appear, and which
 * are required, is the organizers' choice (`fields`); the parts are numbered as they show.
 */
export function ProjectForm({
  eventSlug,
  open,
  tracks,
  questions,
  fields,
  teamName,
  project,
  side,
  face,
}: {
  eventSlug: string;
  open: boolean;
  tracks: { id: string; name: string }[];
  questions: Question[];
  fields: FieldModes;
  /** the name a project without a title of its own is called by */
  teamName: string;
  project: FormProject | null;
  side: React.ReactNode;
  /** the project's generated face, drawn by the page on the server (the face module is server-only) */
  face: React.ReactNode;
}) {
  // Never reset, even after a save: a reset would drop the chosen track and the checklist with it.
  const [state, form, pending] = useFormAction<ActionResult>(saveProjectAction, { ok: false, message: null }, { resetOnSuccess: false });
  // With one track there is nothing to choose: it is filled in already.
  const onlyTrack = tracks.length === 1 ? tracks[0]!.id : "";
  const [checklist, setChecklist] = useState<Needed[]>(() => needed(null, questions, fields, project, onlyTrack));
  const formEl = form.ref;
  const recheck = (el: HTMLFormElement | null) => setChecklist(needed(el, questions, fields, project, onlyTrack));
  // An upload or a take-down changes a hidden input, not a typed one: count it once the field has drawn it.
  const pictureChanged = () => requestAnimationFrame(() => recheck(formEl.current));
  const e = state.fieldErrors ?? {};
  // A refused save names the refused fields and moves focus to the first: the reason sits under its
  // field, often below the fold, and a tester was left guessing field by field from "not valid".
  const refused = Object.keys(e)
    .filter((k) => k !== "request")
    .map((k) => (k.startsWith("answers.") ? (questions.find((q) => q.id === k.slice(8))?.label ?? "an answer") : (LABELS[k] ?? k)));
  useEffect(() => {
    const first = Object.keys(state.fieldErrors ?? {}).find((k) => k !== "request");
    if (!state.ok && first) document.getElementById(first.startsWith("answers.") ? `answer-${first.slice(8)}` : first)?.focus();
  }, [state]);
  const submitted = project?.status === "submitted";
  const ready = checklist.every((n) => n.done);
  const shown = (f: ProjectField) => fields[f] !== "hidden";
  const required = (f: ProjectField) => fields[f] === "required";
  const links = (["repoUrl", "videoUrl", "liveUrl"] as const).filter(shown);

  // The parts in order, each only when it has a field to show, numbered as they appear.
  const parts: { title: string; body: React.ReactNode }[] = [];
  if (shown("title") || shown("summary") || shown("trackId")) {
    parts.push({
      title: shown("trackId") ? (shown("title") ? "Name and track" : "Track") : "Name",
      body: (
        <>
          {shown("title") ? (
            <Field
              id="title"
              label="Title"
              help={required("title") ? undefined : `Leave it empty and the project goes by ${teamName}.`}
              required={required("title")}
              error={e.title}
            >
              {(a) => <Input {...a} name="title" defaultValue={project?.title ?? ""} maxLength={120} />}
            </Field>
          ) : null}
          {shown("summary") ? (
            <Field id="summary" label="One-line summary" help="Shown under the title in the gallery." required={required("summary")} error={e.summary}>
              {(a) => <Input {...a} name="summary" defaultValue={project?.summary ?? ""} maxLength={280} />}
            </Field>
          ) : null}
          {shown("trackId") ? (
            <Field id="trackId" label="Track" required error={e.trackId}>
              {(a) => (
                <select
                  {...a}
                  name="trackId"
                  defaultValue={project?.trackId ?? onlyTrack}
                  className="h-10 w-full rounded-sm border border-edge bg-surface px-3 text-15 aria-invalid:border-l-[3px] aria-invalid:border-flag-bar disabled:bg-sunken"
                >
                  <option value="" disabled>
                    Choose a track
                  </option>
                  {tracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
        </>
      ),
    });
  }
  if (shown("description")) {
    parts.push({
      title: "The write-up",
      body: (
        <Field id="description" label="What you built" help="Judges and visitors read this on your project page." required={required("description")} error={e.description}>
          {(a) => <Textarea {...a} name="description" rows={10} defaultValue={project?.description ?? ""} className="font-serif text-17 leading-7" />}
        </Field>
      ),
    });
  }
  if (links.length) {
    parts.push({
      title: links.length === 1 ? "Link" : "Links",
      body: (
        <div className={`grid gap-5 ${LINK_COLUMNS[links.length]}`}>
          {links.map((f) => (
            <Field key={f} id={f} label={FIELD_LABELS[f]} required={required(f)} error={e[f]}>
              {(a) => <Input {...a} name={f} type="url" inputMode="url" placeholder="https://" defaultValue={project?.[f] ?? ""} />}
            </Field>
          ))}
        </div>
      ),
    });
  }
  if (shown("thumbnailUrl") || shown("tags") || shown("galleryUrls")) {
    const pictureAndTags = shown("thumbnailUrl") && shown("tags");
    parts.push({
      title: shown("thumbnailUrl") || shown("galleryUrls") ? (shown("tags") ? "Pictures and tags" : "Pictures") : "Tags",
      body: (
        <>
          {shown("thumbnailUrl") || shown("tags") ? (
            <div className={`grid gap-5 ${pictureAndTags ? "sm:grid-cols-2" : ""}`}>
              {shown("thumbnailUrl") ? (
                <PictureField projectId={project?.id ?? null} initial={project?.thumbnailUrl ?? null} error={e.thumbnailUrl} face={face} required={required("thumbnailUrl")} onChange={pictureChanged} />
              ) : null}
              {shown("tags") ? (
                <Field id="tags" label="Tech tags" help="Up to 8, separated by commas. Visitors can search for them." required={required("tags")} error={e.tags}>
                  {(a) => <Input {...a} name="tags" placeholder="rust, webgpu, accessibility" defaultValue={(project?.tags ?? []).join(", ")} />}
                </Field>
              ) : null}
            </div>
          ) : null}
          {shown("galleryUrls") ? (
            <Field
              id="galleryUrls"
              label="Image gallery"
              help="Up to 6 image addresses, one per line, shown on your project page."
              required={required("galleryUrls")}
              error={e.galleryUrls}
            >
              {(a) => <Textarea {...a} name="galleryUrls" rows={3} placeholder="https://" defaultValue={(project?.galleryUrls ?? []).join("\n")} className="font-mono text-14" />}
            </Field>
          ) : null}
        </>
      ),
    });
  }
  if (questions.length > 0) {
    parts.push({
      title: "The organizers ask",
      body: questions.map((q) => (
        <Field key={q.id} id={`answer-${q.id}`} label={q.label} help={q.help || undefined} required={q.required} error={e[`answers.${q.id}`]}>
          {(a) =>
            q.type === "longtext" ? (
              <Textarea {...a} name={`answer:${q.id}`} rows={4} defaultValue={project?.answers[q.id] ?? ""} className="font-serif text-17 leading-7" />
            ) : (
              <Input {...a} name={`answer:${q.id}`} type={q.type === "url" ? "url" : "text"} defaultValue={project?.answers[q.id] ?? ""} />
            )
          }
        </Field>
      )),
    });
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,680px)_320px] lg:justify-between">
      <form
        {...form}
        onInput={(ev) => recheck(ev.currentTarget)}
        onChange={(ev) => recheck(ev.currentTarget)}
        className="flex flex-col gap-6"
        noValidate
      >
        <input type="hidden" name="event" value={eventSlug} />
        <input type="hidden" name="project" value={project?.id ?? ""} />
        {!open ? (
          <p className="flex items-start gap-3 border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-14 text-flag">
            <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
            Submissions are closed, so this project is locked: nothing in it can be changed any more, here or through the API.
          </p>
        ) : null}
        <fieldset disabled={!open || pending} className="flex flex-col gap-8 disabled:opacity-100">
          {parts.length ? (
            parts.map((p, i) => (
              <Part key={p.title} no={String(i + 1).padStart(2, "0")} title={p.title}>
                {p.body}
              </Part>
            ))
          ) : (
            <p className="border-t border-rule pt-5 text-15 text-ink-2">
              The organizers ask nothing more: submit to enter {teamName}&rsquo;s project.
            </p>
          )}
          {open ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-6">
              {submitted ? (
                <Button size="lg" name="intent" value="submitted">
                  {pending ? "Saving…" : "Save changes"}
                </Button>
              ) : (
                <>
                  <Button size="lg" name="intent" value="submitted" disabled={!ready}>
                    {pending ? "Saving…" : "Submit project"}
                  </Button>
                  <Button size="lg" variant="outline" name="intent" value="draft">
                    Save draft
                  </Button>
                  {!ready ? <span className="text-13 text-ink-3">Fill the required fields to submit.</span> : null}
                </>
              )}
            </div>
          ) : null}
        </fieldset>
        <p role="status" aria-live="polite" className={state.ok ? "text-14 font-medium text-ok" : "text-14 font-medium text-flag"}>
          {state.message ?? ""}
          {!state.ok && refused.length ? ` Check ${refused.join(", ")}.` : ""}
        </p>
      </form>
      <aside className="flex flex-col gap-8 lg:sticky lg:top-6 lg:self-start">
        <section aria-labelledby="needs-title">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="needs-title" className="label-mono text-ink-2">
              {submitted ? "Submitted project" : "Before you submit"}
            </h2>
            <p className="text-13 text-ink-2 tnum">
              {checklist.filter((n) => n.done).length} of {checklist.length}
            </p>
          </div>
          {checklist.length ? (
            <>
              <ol aria-hidden className="mt-3 flex gap-1">
                {checklist.map((n) => (
                  <li
                    key={n.key}
                    className={`h-1.5 flex-1 rounded-[1px] border transition-colors duration-200 motion-reduce:transition-none ${
                      n.done ? (submitted ? "border-ink bg-ink" : "border-accent bg-accent") : "border-edge"
                    }`}
                  />
                ))}
              </ol>
              <ul className="mt-4 flex flex-col gap-2">
                {checklist.map((n) => (
                  <li key={n.key} className="flex items-center gap-2 text-14">
                    {n.done ? <Check className="size-4 text-ok" aria-hidden /> : <Circle className="size-4 text-ink-3" aria-hidden />}
                    <span className={n.done ? "text-ink" : "text-ink-2"}>{n.label}</span>
                    <span className="sr-only">{n.done ? "done" : "still needed"}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-3 text-14 text-ink-2">Nothing is required: every field here is up to you.</p>
          )}
        </section>
        {side}
      </aside>
    </div>
  );
}
