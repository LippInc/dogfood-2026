import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Face } from "@/components/face";
import { PublicShell } from "@/components/shell/public-shell";
import { formatUtc } from "@/lib/format";
import { actorNav, currentActor, getRecord, NotFoundError, type RecordView } from "@/server/dal";
import { BrowserCheck, ForgeTry, LiveSeal, RecordActions, RecordCheck } from "./check";

export const dynamic = "force-dynamic";

function load(id: string): RecordView {
  try {
    return getRecord(id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

type JudgeRecord = { judging: { finishedReviews: number; tracks: string[]; answers?: number } };
type ParticipantRecord = { project: { id: string; title: string; team: string; track: string | null; awards: string[] } };
type Common = { id: string; kind: "judge" | "participant"; issuer: string; keyId: string; issuedAt: string; person: { name: string }; event: { name: string } };

export async function generateMetadata({ params }: PageProps<"/records/[record]">): Promise<Metadata> {
  try {
    const r = getRecord((await params).record);
    const rec = r.envelope.record as unknown as Common;
    return { title: `${rec.person.name}: ${rec.kind === "judge" ? "judging record" : "certificate"}, ${rec.event.name}` };
  } catch {
    return { title: "Record" };
  }
}

const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export default async function RecordPage({ params }: PageProps<"/records/[record]">) {
  const { record: id } = await params;
  const view = load(id);
  const actor = await currentActor();
  const rec = view.envelope.record as unknown as Common & Partial<JudgeRecord & ParticipantRecord>;
  const key = view.keys.find((k) => k.kid === rec.keyId);
  const awards = rec.project?.awards ?? [];
  const heading = rec.kind === "judge" ? "Judging record" : awards.length ? "Certificate of achievement" : "Certificate of participation";

  return (
    <PublicShell event={view.event} active="none" signedInAs={actor?.name ?? null} links={actorNav(actor, view.event.id)}>
      <RecordCheck envelope={view.envelope}>
      <div className="mx-auto flex max-w-[960px] flex-col gap-10 py-10 print:max-w-none print:py-0">
        <article
          aria-labelledby="record-name"
          className="corner-marks relative flex flex-col gap-8 rounded-sm border border-rule px-6 py-9 outline outline-1 outline-offset-4 outline-rule sm:p-12 print:border-2 print:border-ink print:p-16"
        >
          <div className="flex items-baseline justify-between gap-4">
            <span className="label-mono text-ink-3">[ signed record ]</span>
            <span className="font-mono text-12 text-ink-3">{rec.id}</span>
          </div>

          <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
            <div className="flex min-w-0 flex-col gap-4 wrap-anywhere">
              <p className="text-14 font-medium uppercase tracking-[0.14em] text-ink-2">{heading}</p>
              <h1 id="record-name" className="font-serif text-[40px] leading-[1.1] sm:text-64">
                {rec.person.name}
              </h1>
              <p className="max-w-[640px] font-serif text-20 leading-[1.5] text-ink-2 sm:text-24">
                {rec.kind === "judge" && rec.judging ? (
                  <>
                    {rec.judging.finishedReviews > 0 ? (
                      <>
                        reviewed <strong className="font-semibold text-ink">{rec.judging.finishedReviews}</strong>{" "}
                        {rec.judging.finishedReviews === 1 ? "project" : "projects"}
                        {rec.judging.answers ? " and " : " "}
                      </>
                    ) : null}
                    {rec.judging.answers ? (
                      <>
                        gave <strong className="font-semibold text-ink">{rec.judging.answers}</strong> pairwise{" "}
                        {rec.judging.answers === 1 ? "answer" : "answers"}{" "}
                      </>
                    ) : null}
                    as a judge for{" "}
                    <strong className="font-semibold text-ink">{rec.event.name}</strong>
                    {rec.judging.tracks.length ? (
                      <>
                        , in the {andList(rec.judging.tracks)} {rec.judging.tracks.length === 1 ? "track" : "tracks"}
                      </>
                    ) : null}
                    .
                  </>
                ) : rec.project ? (
                  <>
                    was a member of <strong className="font-semibold text-ink">{rec.project.team}</strong>, who built{" "}
                    <strong className="font-semibold text-ink">{rec.project.title}</strong> for{" "}
                    <strong className="font-semibold text-ink">{rec.event.name}</strong>
                    {rec.project.track ? <>, in the {rec.project.track} track</> : null}.
                  </>
                ) : null}
              </p>
            </div>
            {rec.project ? <Face id={rec.project.id} cols={32} rows={18} className="block h-[135px] w-60 max-md:hidden" /> : null}
          </div>

          {awards.length ? (
            <ul className="flex flex-col gap-2 border-t border-rule pt-6 wrap-anywhere">
              {awards.map((a) => (
                <li key={a} className="font-display text-24 uppercase leading-tight text-accent-ink sm:text-38">
                  {a}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="grid gap-8 border-t border-rule pt-6 md:grid-cols-[minmax(0,1fr)_208px] md:items-start">
          <div className="flex flex-col gap-4">
          <dl className="grid gap-4 text-14 sm:grid-cols-3">
            <div>
              <dt className="text-ink-3">Issued</dt>
              <dd>{formatUtc(rec.issuedAt)}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Signed by</dt>
              <dd className="break-all">{rec.issuer}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Key</dt>
              <dd className="font-mono text-13">{rec.keyId} (Ed25519)</dd>
            </div>
          </dl>
          {view.anchor ? (
            <p className="text-13 text-ink-2">
              Signed when the portal&rsquo;s audit log ended at entry #{view.anchor.entry} (hash{" "}
              <span className="font-mono">{view.anchor.hash.slice(0, 16)}</span>&hellip;).{" "}
              {view.anchor.holds ? "The log still holds that entry as signed." : "The log no longer holds that entry as signed: it was changed after this record was issued."}
            </p>
          ) : null}
          </div>
          <LiveSeal signature={view.envelope.signature} />
          </div>
          <p className="hidden text-12 text-ink-2 print:block">
            Check this record at {rec.issuer}/records/{rec.id}
          </p>
        </article>

        <section aria-labelledby="check-title" className="flex flex-col gap-5 print:hidden">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 id="check-title" className="text-24 font-semibold">
                Check it yourself
              </h2>
              <p className="mt-1 max-w-[640px] text-15 text-ink-2">
                Anyone holding this record can prove the portal issued it and nobody changed it since: the signature covers every word above.
              </p>
            </div>
            <RecordActions envelope={view.envelope} id={rec.id} />
          </div>

          <BrowserCheck serverSays={view.verification.valid} />

          <ol className="flex flex-col gap-6">
            <li className="flex flex-col gap-2">
              <h3 className="text-15 font-semibold">1. What was signed</h3>
              <p className="text-14 text-ink-2">The record as JSON with its keys sorted at every depth and no spaces, as UTF-8 bytes.</p>
              <pre className="whitespace-pre-wrap break-all rounded-sm border border-rule bg-sunken px-4 py-3 font-mono text-12 leading-5">{view.signedText}</pre>
            </li>
            <li className="flex flex-col gap-2">
              <h3 className="text-15 font-semibold">2. The signature</h3>
              <p className="text-14 text-ink-2">Ed25519 over those bytes, in base64url.</p>
              <pre className="whitespace-pre-wrap break-all rounded-sm border border-rule bg-sunken px-4 py-3 font-mono text-12 leading-5">
                {view.envelope.signature}
              </pre>
            </li>
            <li className="flex flex-col gap-2">
              <h3 className="text-15 font-semibold">3. The public key</h3>
              <p className="text-14 text-ink-2">
                Published at{" "}
                <a href="/.well-known/dogfood-keys.json" className="underline underline-offset-4">
                  /.well-known/dogfood-keys.json
                </a>{" "}
                as a JWK; the private half never leaves the portal&rsquo;s database. Save the key once, and later checks need no network.
              </p>
              <pre className="whitespace-pre-wrap break-all rounded-sm border border-rule bg-sunken px-4 py-3 font-mono text-12 leading-5">
                {key ? JSON.stringify({ kid: key.kid, kty: key.kty, crv: key.crv, x: key.x }) : "This record's key is not published by this portal."}
              </pre>
            </li>
            <li className="flex flex-col gap-2">
              <h3 className="text-15 font-semibold">4. Check it without this page</h3>
              <p className="text-14 text-ink-2">
                With Node 22 or newer and the portal&rsquo;s repository: <code className="font-mono text-13 break-all">node scripts/verify-record.mjs {rec.issuer}/records/{rec.id}</code>,
                or paste the downloaded record into <a href="/verify" className="underline underline-offset-4">the verify page</a>.
              </p>
            </li>
            <li className="flex flex-col gap-2">
              <h3 className="text-15 font-semibold">5. Try to forge it</h3>
              <ForgeTry envelope={view.envelope} />
            </li>
          </ol>
        </section>
      </div>
      </RecordCheck>
    </PublicShell>
  );
}
