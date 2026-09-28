"use client";

import { useState } from "react";
import { allowedModes, FIELD_LABELS, FIELD_MODES, PROJECT_FIELDS, type FieldMode, type FieldModes, type ProjectField } from "@/lib/project-fields";

const MODE_LABELS: Record<FieldMode, string> = { required: "Required", optional: "Optional", hidden: "Hidden" };

/** What each field is, in a line, so an organizer can tell what they turn off. */
function hint(field: ProjectField, tracks: number): string {
  switch (field) {
    case "title":
      return "The project's name. Optional or hidden: a project without one is called by its team's name.";
    case "summary":
      return "One line under the title, in the gallery and the judge's console.";
    case "trackId":
      return tracks === 1
        ? "Hidden gives every team the event's one track. Never optional: every project needs a track."
        : "Each team chooses one of the event's tracks. It can be hidden only while the event has one track.";
    case "description":
      return "The write-up judges read, as long as the team likes.";
    case "repoUrl":
      return "A link to the code.";
    case "videoUrl":
      return "A link to a demo video.";
    case "liveUrl":
      return "A link to the running project.";
    case "thumbnailUrl":
      return "The gallery card's image; without one the card shows the project's drawn face.";
    case "galleryUrls":
      return "Up to 6 images on the project page.";
    case "tags":
      return "Up to 8 tags visitors can search for.";
  }
}

/**
 * The project form's built-in fields, each with a joined three-way choice (the rubric's joined
 * buttons, as radios, so arrow keys move within a field and Tab moves between fields). Under the
 * list, the form as a team will meet it, following the choices as they change.
 */
export function ProjectFieldsEditor({ saved, tracks, questions }: { saved: FieldModes; tracks: number; questions: number }) {
  const [modes, setModes] = useState<FieldModes>(saved);
  const by = (m: FieldMode) => PROJECT_FIELDS.filter((f) => modes[f] === m).map((f) => FIELD_LABELS[f]);
  const lines: [string, string][] = [
    ["Required", by("required").join(", ")],
    ["Optional", by("optional").join(", ")],
    ["Not asked", by("hidden").join(", ")],
    ["Your questions", questions ? `${questions}, in the next section` : ""],
  ];
  return (
    <div className="flex flex-col gap-5">
      <ul className="border-b border-rule">
        {PROJECT_FIELDS.map((f) => {
          const allowed = allowedModes(f, tracks);
          const labelId = `pf-${f}-label`;
          return (
            <li key={f} className="grid gap-2 border-t border-rule py-3 sm:grid-cols-[minmax(0,1fr)_17rem] sm:items-center sm:gap-6">
              <div className="min-w-0">
                <p id={labelId} className="text-14 font-medium">
                  {FIELD_LABELS[f]}
                </p>
                <p id={`pf-${f}-hint`} className="text-13 text-ink-2">
                  {hint(f, tracks)}
                </p>
              </div>
              <div role="radiogroup" aria-labelledby={labelId} aria-describedby={`pf-${f}-hint`} className="flex">
                {FIELD_MODES.map((m) => {
                  const off = !allowed.includes(m);
                  return (
                    <label
                      key={m}
                      className={`relative flex h-8 flex-1 items-center justify-center border border-edge px-2 text-13 font-medium -ml-px first:ml-0 first:rounded-l-sm last:rounded-r-sm has-[:checked]:z-[1] has-[:checked]:border-primary has-[:checked]:bg-primary has-[:checked]:text-on-primary has-[:focus-visible]:z-10 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                        off ? "cursor-not-allowed bg-sunken text-ink-3" : "cursor-pointer hover:bg-raised"
                      }`}
                    >
                      <input
                        type="radio"
                        name={f}
                        value={m}
                        checked={modes[f] === m}
                        disabled={off}
                        onChange={() => setModes((prev) => ({ ...prev, [f]: m }))}
                        className="sr-only"
                      />
                      {MODE_LABELS[m]}
                    </label>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-1.5">
        <p className="label-mono text-ink">What a team is asked</p>
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-13">
          {lines.map(([name, list]) => (
            <div key={name} className="contents">
              <dt className="text-ink-2">{name}</dt>
              <dd className={list ? "text-ink" : "text-ink-3"}>{list || "none"}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-1 text-13 text-ink-2">
          Hiding a field keeps what teams already entered in it: nobody sees it while the field is hidden, and it shows again if you turn the
          field back on.
        </p>
      </div>
    </div>
  );
}
