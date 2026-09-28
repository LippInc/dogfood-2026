import type { Metadata } from "next";
import Link from "next/link";
import { PlainShell } from "@/components/shell/plain-shell";
import { openApiDocument, OPERATIONS, operationId, type Operation } from "@/server/dal";

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

export default function ApiDocsPage() {
  const doc = openApiDocument(process.env.PUBLIC_URL ?? "http://localhost:8080");
  const tags = [...new Set(OPERATIONS.map((o) => o.tag))];
  return (
    <PlainShell width="max-w-[1040px]">
      <h1 className="font-display text-38">API</h1>
      <div className="mt-3 flex max-w-[720px] flex-col gap-3 text-15 text-ink-2">
        <p>
          Everything the interface does, as JSON: {OPERATIONS.length} operations. The same checks run as in the interface, in the same data access layer, so
          the API can do nothing a person could not.
        </p>
        <p>
          Authenticate with the <code className="font-mono text-13">session</code> cookie from signing in, or send an{" "}
          <Link href="/account/tokens" className="underline underline-offset-4">
            API token
          </Link>{" "}
          as <code className="font-mono text-13">Authorization: Bearer &lt;token&gt;</code>; it acts as the person who made it. A refusal is a real 401 (no valid session) or 403 (not allowed) with a
          JSON body <code className="font-mono text-13">{'{ "error": "<code>", "message": "..." }'}</code>, never a redirect.
        </p>
        <p>
          Machine-readable:{" "}
          <a href="/api/openapi.json" className="underline underline-offset-4">
            /api/openapi.json
          </a>{" "}
          (OpenAPI {doc.openapi}). The request bodies below are the server&rsquo;s own validators, converted.
        </p>
      </div>

      <nav aria-label="Sections" className="mt-8 flex flex-wrap gap-2">
        {tags.map((t) => (
          <a key={t} href={`#${t.toLowerCase().replace(/\s+/g, "-")}`} className="inline-flex h-8 items-center rounded-sm border border-edge px-3 text-13 hover:bg-raised">
            {t}
          </a>
        ))}
      </nav>

      <div className="mt-10 flex flex-col gap-12">
        {tags.map((tag) => (
          <section key={tag} id={tag.toLowerCase().replace(/\s+/g, "-")} aria-labelledby={`${tag}-title`} className="scroll-mt-6">
            <h2 id={`${tag}-title`} className="border-b border-rule pb-2 text-24 font-semibold">
              {tag}
            </h2>
            <ul className="divide-y divide-rule">
              {OPERATIONS.filter((o) => o.tag === tag).map((op) => {
                const entry = doc.paths[op.path]?.[op.method.toLowerCase()] as Documented | undefined;
                const schema = op.body ? entry?.requestBody?.content["application/json"].schema : undefined;
                const codes = Object.keys(entry?.responses ?? {}).map(Number);
                const ok = codes.filter((c) => c < 300);
                const refusals = codes.filter((c) => c >= 400);
                return (
                  <li key={operationId(op)} id={operationId(op)} className="scroll-mt-6 py-5 sm:grid sm:grid-cols-[64px_minmax(0,1fr)] sm:gap-x-3">
                    <span className={`font-mono text-13 leading-5 font-semibold ${METHOD_TONE[op.method]}`}>{op.method}</span>
                    <div className="mt-1 flex min-w-0 flex-col gap-2 sm:mt-0">
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
        ))}
      </div>
    </PlainShell>
  );
}
