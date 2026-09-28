import type { Metadata } from "next";
import Link from "next/link";
import { PlainShell } from "@/components/shell/plain-shell";
import { openApiDocument, OPERATIONS, operationId, type Operation } from "@/server/dal";
import { SectionMarker } from "./section-marker";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "API" };

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  format?: string;
  default?: unknown;
  additionalProperties?: Schema | boolean;
};

/** A JSON Schema written the way a person reads a body: { name?: string (≤ 80) }. */
function shape(s: Schema, depth = 0): string {
  const pad = "  ".repeat(depth + 1);
  if (s.anyOf) return s.anyOf.map((x) => shape(x, depth)).join(" | ");
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if ("const" in s) return JSON.stringify(s.const);
  const type = Array.isArray(s.type) ? s.type.join(" | ") : s.type;
  if (type === "object" && s.properties) {
    const req = new Set(s.required ?? []);
    const lines = Object.entries(s.properties).map(([k, v]) => `${pad}${k}${req.has(k) ? "" : "?"}: ${shape(v, depth + 1)}`);
    return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
  }
  if (type === "object") return typeof s.additionalProperties === "object" ? `{ [key: string]: ${shape(s.additionalProperties, depth)} }` : "object";
  if (type === "array") return `${s.items ? shape(s.items, depth) : "unknown"}[]${s.minItems ? ` (at least ${s.minItems})` : ""}`;
  const range = (lo?: number, hi?: number, unit = "") =>
    lo !== undefined && hi !== undefined ? ` (${lo}–${hi}${unit})` : hi !== undefined ? ` (≤ ${hi}${unit})` : lo ? ` (≥ ${lo}${unit})` : "";
  if (type === "string") return `string${s.format ? ` <${s.format}>` : ""}${range(s.minLength, s.maxLength, " chars")}`;
  if (type === "integer" || type === "number") return `${type}${range(s.minimum, s.maximum)}`;
  return type ?? "unknown";
}

type Documented = {
  requestBody?: { content: { "application/json": { schema: Schema } } };
  responses?: Record<string, { description: string }>;
};

const METHOD_TONE: Record<Operation["method"], string> = {
  GET: "text-teal",
  POST: "text-accent-ink",
  PUT: "text-ink",
  DELETE: "text-flag",
};

const slug = (tag: string) => tag.toLowerCase().replace(/\s+/g, "-");

/** Who may call it, in three strengths: anyone, a person with a part in the event, the people who run it. */
type Reach = "open" | "part" | "run";
const REACH: Record<Operation["access"], Reach> = {
  anyone: "open",
  "signed in": "part",
  "team member": "part",
  captain: "part",
  judge: "part",
  voter: "part",
  organizer: "run",
  administrator: "run",
};
const PIXEL: Record<Reach, string> = {
  open: "border border-face-dot",
  part: "bg-[repeating-conic-gradient(var(--face-dot)_0_25%,transparent_0_50%)] bg-size-[4px_4px]",
  run: "bg-face-dot",
};

function Pixel({ reach, className = "" }: { reach: Reach; className?: string }) {
  return <span aria-hidden="true" className={`inline-block size-2 shrink-0 ${PIXEL[reach]} ${className}`} />;
}

export default function ApiDocsPage() {
  const doc = openApiDocument(process.env.PUBLIC_URL ?? "http://localhost:8080");
  const base = doc.servers[0]!.url;
  const tags = [...new Set(OPERATIONS.map((o) => o.tag))];
  // every answer the document names, with its meaning and how many operations can give it
  const answers = new Map<number, { description: string; count: number }>();
  for (const methods of Object.values(doc.paths)) {
    for (const entry of Object.values(methods) as Documented[]) {
      for (const [code, r] of Object.entries(entry.responses ?? {})) {
        const a = answers.get(Number(code)) ?? { description: r.description, count: 0 };
        a.count += 1;
        answers.set(Number(code), a);
      }
    }
  }
  const answerRows = [...answers.entries()].sort(([x], [y]) => x - y);
  return (
    <PlainShell width="max-w-[1200px]">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <h1 className="font-display text-[48px] leading-[52px] md:text-64">API</h1>
        <p className="label-mono tnum text-ink-2 tracking-[0.06em] sm:tracking-[0.12em] md:pb-2">
          {OPERATIONS.length} operations · {tags.length} sections · OpenAPI {doc.openapi}
        </p>
      </div>
      <p className="mt-6 max-w-[680px] text-17 leading-7 text-ink-2">
        Everything the interface does, as JSON. The same checks run as in the interface, in the same data access layer, so the API can do nothing a person
        could not.
      </p>

      <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-12 border-t border-rule pt-8 lg:grid-cols-[272px_minmax(0,1fr)] lg:gap-16">
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <nav id="api-index" aria-labelledby="index-title">
            <SectionMarker nav="api-index" />
            <h2 id="index-title" className="label-mono text-ink">
              FIG. 01 · The API by section
            </h2>
            <ol className="mt-4 flex flex-col divide-y divide-rule border-y border-rule">
              {tags.map((tag, i) => {
                const ops = OPERATIONS.filter((o) => o.tag === tag);
                return (
                  <li key={tag}>
                    <a href={`#${slug(tag)}`} className="group grid min-h-11 grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3 py-2.5 text-14 hover:[--face-dot:var(--accent)] aria-[current=location]:[--face-dot:var(--accent)]">
                      <span className="font-mono text-12 leading-5 text-ink-3 group-aria-[current=location]:text-accent-ink">{String(i + 1).padStart(2, "0")}</span>
                      <span className="min-w-0">
                        <span className="group-hover:underline group-aria-[current=location]:font-semibold">{tag}</span>
                        <span className="mt-1.5 flex flex-wrap gap-[3px]">
                          {ops.map((o) => (
                            <Pixel key={operationId(o)} reach={REACH[o.access]} />
                          ))}
                        </span>
                      </span>
                      <span className="text-13 leading-5 text-ink-3 tnum">{ops.length}</span>
                    </a>
                  </li>
                );
              })}
            </ol>
            <ul className="mt-4 flex flex-col gap-1.5 text-12 leading-4 text-ink-3" aria-label="Key: one square per operation, by who may call it">
              <li className="flex items-start gap-2">
                <Pixel reach="open" className="mt-1" /> anyone, no session
              </li>
              <li className="flex items-start gap-2">
                <Pixel reach="part" className="mt-1" /> a person with a part: signed in, team, judge, voter
              </li>
              <li className="flex items-start gap-2">
                <Pixel reach="run" className="mt-1" /> the organizers or an administrator
              </li>
            </ul>
          </nav>
        </aside>

        <div className="min-w-0">
          <section aria-labelledby="start-title">
            <h2 id="start-title" className="label-mono text-ink">
              Before your first call
            </h2>
            <ol className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <li className="border-t-2 border-ink pt-3">
                <p className="font-mono text-12 text-accent-ink">01</p>
                <h3 className="mt-2 text-17 font-semibold">Where it answers</h3>
                <p className="mt-1 text-14 text-ink-2">Every path below starts from this portal&rsquo;s address. A path part in braces is yours to fill in.</p>
                <pre className="mt-3 overflow-x-auto rounded-sm border border-rule bg-sunken px-4 py-3 font-mono text-12 leading-5 text-ink-2">
                  <span className="text-ink-3"># anyone</span>
                  {`\ncurl ${base}/api/events\n`}
                  <span className="text-ink-3"># as the person who made the token</span>
                  {`\ncurl -H "Authorization: Bearer <token>" \\\n  ${base}/api/events/`}
                  <span className="text-ink-3">{"{event}"}</span>
                  {"/overview"}
                </pre>
              </li>
              <li className="border-t-2 border-ink pt-3">
                <p className="font-mono text-12 text-accent-ink">02</p>
                <h3 className="mt-2 text-17 font-semibold">Who you are</h3>
                <p className="mt-1 text-14 text-ink-2">
                  The <code className="font-mono text-13">session</code> cookie from signing in, or an{" "}
                  <Link href="/account/tokens" className="underline underline-offset-4">
                    API token
                  </Link>{" "}
                  sent as <code className="font-mono text-13">Authorization: Bearer &lt;token&gt;</code>. A token acts as the person who made it, with
                  exactly their rights.
                </p>
                <p className="mt-3 text-14 text-ink-2">
                  The whole reference, machine-readable:{" "}
                  <a href="/api/openapi.json" className="font-mono text-13 underline underline-offset-4">
                    /api/openapi.json
                  </a>
                  . The request bodies are the server&rsquo;s own validators, converted.
                </p>
              </li>
              <li className="border-t-2 border-ink pt-3 xl:col-span-2">
                <p className="font-mono text-12 text-accent-ink">03</p>
                <h3 className="mt-2 text-17 font-semibold">What it answers</h3>
                <p className="mt-1 max-w-[680px] text-14 text-ink-2">
                  A refusal is a real status with a JSON body, <code className="font-mono text-13">{'{ "error": "<code>", "message": "..." }'}</code>, never a
                  redirect. Each operation lists the answers it can give.
                </p>
                <table className="mt-4 w-full text-14">
                  <caption className="sr-only">Every answer the API can give</caption>
                  <thead className="label-mono text-left text-ink-3">
                    <tr>
                      <th scope="col" className="pr-4 pb-2 font-normal whitespace-nowrap">Status</th>
                      <th scope="col" className="pb-2 font-normal">Meaning</th>
                      <th scope="col" className="pb-2 text-right font-normal whitespace-nowrap">Operations</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule border-y border-rule">
                    {answerRows.map(([code, a]) => (
                      <tr key={code}>
                        <th scope="row" className={`w-20 py-2 text-left align-top font-mono text-13 font-semibold ${code < 300 ? "text-ok" : "text-ink"}`}>
                          {code}
                        </th>
                        <td className="py-2 pr-4 align-top text-ink-2">{a.description}</td>
                        <td className="py-2 text-right align-top text-13 whitespace-nowrap text-ink-3 tnum">{a.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </li>
            </ol>
          </section>

          <div className="mt-16 flex flex-col gap-16">
            {tags.map((tag, i) => {
              const ops = OPERATIONS.filter((o) => o.tag === tag);
              return (
                <section key={tag} id={slug(tag)} aria-labelledby={`${slug(tag)}-title`} className="scroll-mt-6">
                  <div className="flex items-baseline gap-4 border-b-2 border-ink pb-2">
                    <span className="font-mono text-12 text-accent-ink">{String(i + 1).padStart(2, "0")}</span>
                    <h2 id={`${slug(tag)}-title`} className="text-24 font-semibold">
                      {tag}
                    </h2>
                    <span className="ml-auto text-13 text-ink-3 tnum">
                      {ops.length} {ops.length === 1 ? "operation" : "operations"}
                    </span>
                  </div>
                  <ul className="divide-y divide-rule">
                    {ops.map((op) => {
                      const entry = doc.paths[op.path]?.[op.method.toLowerCase()] as Documented | undefined;
                      const schema = op.body ? entry?.requestBody?.content["application/json"].schema : undefined;
                      const codes = Object.keys(entry?.responses ?? {}).map(Number);
                      const ok = codes.filter((c) => c < 300);
                      const refusals = codes.filter((c) => c >= 400);
                      return (
                        <li key={operationId(op)} id={operationId(op)} className="grid scroll-mt-6 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 py-4 sm:grid-cols-[64px_minmax(0,1fr)]">
                          <span className={`font-mono text-13 leading-5 font-semibold ${METHOD_TONE[op.method]}`}>{op.method}</span>
                          <code className="font-mono text-14 leading-5 break-all text-ink">
                            {op.path.split(/(\{\w+\})/).map((part, i) =>
                              /^\{\w+\}$/.test(part) ? (
                                <span key={i} className="text-ink-3">
                                  {part}
                                </span>
                              ) : (
                                part
                              ),
                            )}
                          </code>
                          <div className="col-span-2 mt-2 flex min-w-0 flex-col gap-2 sm:col-span-1 sm:col-start-2">
                            <p className="text-15">{op.summary}</p>
                            {op.note ? <p className="max-w-[720px] text-14 text-ink-2">{op.note}</p> : null}
                            <dl className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-12 leading-4">
                              <div className="flex gap-2">
                                <dt className="text-ink-3">WHO</dt>
                                <dd className="text-ink-2">{op.access}</dd>
                              </div>
                              <div className="flex gap-2">
                                <dt className="text-ink-3">ANSWERS</dt>
                                <dd className="tnum text-ink-2">
                                  <span className="text-ok">{ok.join(" ")}</span>
                                  {refusals.length ? <span> · {refusals.join(" ")}</span> : null}
                                </dd>
                              </div>
                            </dl>
                            {schema ? (
                              <details className="group">
                                <summary className="w-fit cursor-pointer text-13 text-ink-2 hover:text-ink">Request body</summary>
                                <pre className="mt-2 overflow-x-auto rounded-sm border border-rule bg-sunken px-4 py-3 font-mono text-12 leading-5">{shape(schema)}</pre>
                              </details>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </PlainShell>
  );
}
