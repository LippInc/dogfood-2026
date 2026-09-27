import Link from "next/link";
import { Lock } from "lucide-react";
import { formatUtc } from "@/lib/format";
import type { Question } from "@/server/dal";
import type { FormProject } from "./project-form";

/** "https://example.org/repo/01" -> "example.org/repo/01": the address without its scheme, for a mono row. */
function bare(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function Row({ label, children, first }: { label: string; children: React.ReactNode; first?: boolean }) {
  return (
    <div className={`contents ${first ? "" : "[&>*]:border-t [&>*]:border-rule"}`}>
      <dt className="py-2.5 pr-4 text-14 text-ink-2">{label}</dt>
      <dd className="min-w-0 py-2.5 text-15 wrap-anywhere">{children}</dd>
    </div>
  );
}

function Missing({ children = "not submitted" }: { children?: React.ReactNode }) {
  return <span className="text-ink-3">{children}</span>;
}

function Out({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex max-w-full items-center gap-1.5 rounded-xs font-mono text-13 text-ink underline decoration-edge underline-offset-4 hover:decoration-ink"
    >
      <span className="truncate">{bare(url)}</span>
      <span aria-hidden>↗</span>
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** A numbered part, in the same voice as the open form ("02 · The write-up"), so both states read as one document. */
function Part({ no, title, aside, children }: { no: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  const id = `handed-${no}`;
  return (
    <section aria-labelledby={id} className="border-t border-rule px-5 py-5 sm:px-6">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={id} className="flex items-baseline gap-3">
          <span className="font-mono text-12 text-accent-ink tnum">{no}</span>
          <span className="label-mono text-ink-2">{title}</span>
        </h3>
        {aside ? <p className="text-12 text-ink-2 tnum">{aside}</p> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * After the close the form has nothing left to do: the team sees what it handed in, as the
 * judges read it, with every empty field named as empty instead of an empty locked box.
 */
export function HandedIn({
  eventSlug,
  closedAt,
  project,
  trackName,
  questions,
}: {
  eventSlug: string;
  closedAt: string;
  project: FormProject | null;
  trackName: string | null;
  questions: Question[];
}) {
  const links: [string, string | null][] = project
    ? [
        ["Repository", project.repoUrl],
        ["Demo video", project.videoUrl],
        ["Live demo", project.liveUrl],
      ]
    : [];
  const given = links.filter(([, url]) => url).length;
  const submitted = project?.status === "submitted";
  const paragraphs = (project?.description ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  return (
    <section aria-labelledby="handed-title" className="flex min-w-0 flex-col gap-4">
      <p className="flex items-start gap-3 rounded-sm bg-sunken px-4 py-3 text-14 text-ink-2">
        <Lock className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
        <span>
          Submissions are closed, so this project is locked: it is what the judges see. The server refuses every edit, not only this page.
        </span>
      </p>
      <div className="rounded-sm border border-rule bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4 sm:px-6">
          <h2 id="handed-title" className="label-mono text-ink">
            {submitted ? "What you handed in" : project ? "Your draft" : "Nothing handed in"}
          </h2>
          <p className="font-mono text-12 text-ink-2">
            {submitted && project ? (
              <>
                {project.id} · locked {formatUtc(closedAt)}
              </>
            ) : project ? (
              "never submitted, so not judged"
            ) : (
              `closed ${formatUtc(closedAt)}`
            )}
          </p>
        </div>
        {!project ? (
          <p className="border-t border-rule px-5 py-6 text-15 text-ink-2 sm:px-6">
            Your team did not start a project before submissions closed, so there is nothing for the judges to read.
          </p>
        ) : (
          <>
            <Part no="01" title="Name and track">
              <dl className="grid grid-cols-[104px_minmax(0,1fr)] sm:grid-cols-[136px_minmax(0,1fr)]">
                <Row label="Title" first>
                  {project.title ? <span className="font-medium">{project.title}</span> : <Missing>no title</Missing>}
                </Row>
                <Row label="Summary">{project.summary ? <span className="font-serif text-17 leading-7">{project.summary}</span> : <Missing>no summary</Missing>}</Row>
                <Row label="Track">{trackName ?? <Missing>no track</Missing>}</Row>
              </dl>
            </Part>
            <Part no="02" title="The write-up">
              {paragraphs.length ? (
                <div className="flex max-w-[640px] flex-col gap-4 font-serif text-17 leading-7">
                  {paragraphs.map((p, i) => (
                    <p key={i} className="whitespace-pre-line">
                      {p}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="rounded-sm border border-dashed border-edge px-4 py-5 text-14 text-ink-2">
                  No write-up was handed in.
                </p>
              )}
            </Part>
            <Part no="03" title="Links" aside={`${given} of ${links.length}`}>
              <dl className="grid grid-cols-[104px_minmax(0,1fr)] sm:grid-cols-[136px_minmax(0,1fr)]">
                {links.map(([label, url], n) => (
                  <Row key={label} label={label} first={n === 0}>
                    {url ? <Out url={url} /> : <Missing />}
                  </Row>
                ))}
              </dl>
            </Part>
            <Part no="04" title="Pictures and tags">
              <dl className="grid grid-cols-[104px_minmax(0,1fr)] sm:grid-cols-[136px_minmax(0,1fr)]">
                <Row label="Thumbnail" first>
                  {project.thumbnailUrl ? <Out url={project.thumbnailUrl} /> : <Missing>none; the gallery shows your generated face</Missing>}
                </Row>
                <Row label="Image gallery">
                  {project.galleryUrls.length ? (
                    <ul className="flex flex-col gap-1">
                      {project.galleryUrls.map((u) => (
                        <li key={u} className="min-w-0">
                          <Out url={u} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Missing>no images</Missing>
                  )}
                </Row>
                <Row label="Tech tags">
                  {project.tags.length ? (
                    <ul className="flex flex-wrap gap-1.5">
                      {project.tags.map((t) => (
                        <li key={t} className="rounded-xs border border-rule px-1.5 font-mono text-12 text-ink-2">
                          {t}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Missing>no tags</Missing>
                  )}
                </Row>
              </dl>
            </Part>
            {questions.length > 0 ? (
              <Part no="05" title="The organizers ask">
                <dl className="flex flex-col gap-4">
                  {questions.map((q) => (
                    <div key={q.id}>
                      <dt className="text-14 text-ink-2">{q.label}</dt>
                      <dd className="mt-1 font-serif text-17 leading-7 whitespace-pre-line wrap-anywhere">
                        {project.answers[q.id] || <Missing>not answered</Missing>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Part>
            ) : null}
            {submitted ? (
              <div className="border-t border-rule px-5 py-4 sm:px-6">
                <Link
                  href={`/events/${eventSlug}/projects/${project.id}`}
                  className="inline-flex h-10 items-center rounded-sm border border-edge px-4 text-14 font-medium hover:bg-sunken"
                >
                  See your project page as visitors do
                </Link>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
