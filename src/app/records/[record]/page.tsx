import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DitherDigits } from "@/components/dither-digits";
import { Face } from "@/components/face";
import { PublicShell } from "@/components/shell/public-shell";
import { formatUtc } from "@/lib/format";
import { actorNav, currentActor, getRecord, NotFoundError, type RecordView } from "@/server/dal";
import { BrowserCheck, CheckedSheet, ForgeTry, LiveBits, LiveSeal, RecordActions, RecordCheck } from "./check";

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

/** A podium award as the record words it ("Joint 1st place, Health"), read back into its parts; other awards stay whole. */
function placeOf(award: string): { place: number; ordinal: string; joint: boolean; track: string } | null {
  const m = /^(Joint )?(([0-9]+)(?:st|nd|rd|th)) place, (.+)$/.exec(award);
  return m ? { joint: Boolean(m[1]), ordinal: m[2]!, place: Number(m[3]), track: m[4]! } : null;
}

const recordLink = "rounded-xs font-medium underline decoration-edge underline-offset-4 hover:decoration-ink";

const bytesBox = "whitespace-pre-wrap break-all rounded-sm border border-rule bg-sunken px-4 py-3 font-mono text-12 leading-5";

/** One step of the check, drawn as a ledger row: its number and why on the left, the evidence on the right. */
function Step({ n, title, why, children }: { n: number; title: string; why: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="grid gap-3 border-t border-rule py-6 md:grid-cols-[240px_minmax(0,1fr)] md:gap-10">
      <div className="flex flex-col gap-1.5">
        <span className="label-mono text-accent-ink">Step {String(n).padStart(2, "0")}</span>
        <h3 className="text-17 font-semibold">{title}</h3>
        <p className="text-14 text-ink-2">{why}</p>
      </div>
      <div className="min-w-0 md:pt-6">{children}</div>
    </li>
  );
}

const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export default async function RecordPage({ params }: PageProps<"/records/[record]">) {
  const { record: id } = await params;
  const view = load(id);
  const actor = await currentActor();
  const rec = view.envelope.record as unknown as Common & Partial<JudgeRecord & ParticipantRecord>;
  const key = view.keys.find((k) => k.kid === rec.keyId);
  const awards = rec.project?.awards ?? [];
  // the name inside the signed bytes, so step 1 can mark the letters step 5 changes
  const nameJson = `"person":{"name":${JSON.stringify(rec.person.name)}`;
  const at = view.signedText.indexOf(nameJson);
  const signedParts =
    at < 0
      ? null
      : ([
          view.signedText.slice(0, at + nameJson.length - JSON.stringify(rec.person.name).length),
          JSON.stringify(rec.person.name),
          view.signedText.slice(at + nameJson.length),
        ] as const);
  const heading = rec.kind === "judge" ? "Judging record" : awards.length ? "Certificate of achievement" : "Certificate of participation";

  return (
    <PublicShell event={view.event} active="none" signedInAs={actor?.name ?? null} links={actorNav(actor, view.event.id)}>
      <RecordCheck envelope={view.envelope}>
      <div className="mx-auto flex max-w-[960px] flex-col gap-10 py-6 sm:py-8 print:max-w-none print:py-0">
        <div className="flex flex-col gap-3">
        <CheckedSheet
          aria-labelledby="record-name"
          className="corner-marks [&.lit]:[--mark:var(--accent)] relative flex flex-col gap-6 rounded-sm border border-rule px-6 py-8 outline outline-1 outline-offset-4 outline-rule sm:px-12 sm:py-9 print:break-inside-avoid print:gap-8 print:border-2 print:border-ink print:p-12"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <p className="text-14 font-medium uppercase tracking-[0.14em] text-ink-2">{heading}</p>
            <p className="flex items-baseline gap-3 text-ink-3">
              <span className="label-mono">[ signed record ]</span>
              <span className="font-mono text-12">{rec.id}</span>
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-start print:grid-cols-[minmax(0,1fr)_auto] print:items-start">
            <div className="flex min-w-0 flex-col gap-3 wrap-anywhere">
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
            {rec.project ? <Face id={rec.project.id} cols={32} rows={18} className="block h-auto w-full md:h-[135px] md:w-60 print:h-[135px] print:w-60" /> : null}
          </div>

          {awards.length ? (
            <ul className="flex flex-col gap-6 border-t border-rule pt-6 wrap-anywhere">
              {awards.map((a) => {
                const p = placeOf(a);
                return (
                  <li key={a} className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-x-5 sm:grid-cols-[72px_minmax(0,1fr)] sm:gap-x-7">
                    {p ? (
                      <DitherDigits
                        value={String(p.place)}
                        className="[&_path]:transition-[fill] [&_path]:duration-500 motion-reduce:[&_path]:transition-none [.lit_&_path]:fill-accent"
                      />
                    ) : (
                      <span aria-hidden className="block aspect-square w-full bg-face-bg [.lit_&]:bg-accent" />
                    )}
                    <p className="flex flex-col gap-1">
                      <span className="font-display text-24 uppercase leading-tight text-accent-ink sm:text-38">{p ? `${p.joint ? "Joint " : ""}${p.ordinal} place` : a}</span>
                      {p ? <span className="font-serif text-17 text-ink-2 sm:text-20">in the {p.track} track</span> : null}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <div className="grid gap-8 border-t border-rule pt-6 md:grid-cols-[minmax(0,1fr)_208px] md:items-start print:grid-cols-[minmax(0,1fr)_208px] print:items-start">
          <div className="flex flex-col gap-4">
          <dl className="grid gap-1.5 text-14 max-sm:[&>div]:grid max-sm:[&>div]:grid-cols-[80px_minmax(0,1fr)] max-sm:[&>div]:gap-3 sm:grid-cols-3 sm:gap-4 print:grid-cols-1! print:gap-1.5 print:[&>div]:grid print:[&>div]:grid-cols-[88px_minmax(0,1fr)] print:[&>div]:gap-3">
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
          {view.renamed ? (
            <p className="text-13 text-ink-2">
              Signed when the event was called &ldquo;{view.renamed.signed}&rdquo;. The organizers have renamed it &ldquo;{view.renamed.now}&rdquo; since; the
              record keeps the name it was signed with.
            </p>
          ) : null}
          </div>
          <LiveSeal signature={view.envelope.signature} />
          </div>
          <p className="hidden text-12 text-ink-2 print:block">
            Check this record at {rec.issuer}/records/<span className="font-mono text-13 text-ink">{rec.id}</span>
          </p>
        </CheckedSheet>

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 print:hidden">
          <nav aria-label="Where this record comes from" className="flex flex-wrap gap-x-6 gap-y-2 text-15">
            {rec.project ? (
              <Link href={`/events/${view.event.slug}/projects/${rec.project.id}`} className={recordLink}>
                {rec.project.title}&rsquo;s project page
              </Link>
            ) : null}
            <Link href={`/events/${view.event.slug}/results`} className={recordLink}>
              {view.event.name} results
            </Link>
          </nav>
          <RecordActions envelope={view.envelope} id={rec.id} />
        </div>
        </div>

        <section aria-labelledby="check-title" className="flex flex-col gap-5 print:hidden">
          <div>
            <h2 id="check-title" className="text-24 font-semibold">
              Check it yourself
            </h2>
            <p className="mt-1 max-w-[640px] text-15 text-ink-2">
              Anyone holding this record can prove the portal issued it and nobody changed it since: the signature covers every word above.
            </p>
          </div>

          <BrowserCheck serverSays={view.verification.valid} />

          <ol className="flex flex-col">
            <Step n={1} title="What was signed" why="The record as JSON with its keys sorted at every depth and no spaces, as UTF-8 bytes. The name is marked: step 5 changes one letter of it.">
              <pre className={bytesBox}>
                {signedParts ? (
                  <>
                    {signedParts[0]}
                    <mark className="rounded-xs bg-accent-tint px-0.5 text-ink">{signedParts[1]}</mark>
                    {signedParts[2]}
                  </>
                ) : (
                  view.signedText
                )}
              </pre>
            </Step>
            <Step n={2} title="The signature" why="Ed25519 over those bytes, in base64url: 64 bytes. The seal on the record draws them, one square per bit.">
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_128px] sm:items-start">
                <pre className={bytesBox}>{view.envelope.signature}</pre>
                <div className="max-sm:hidden">
                  <LiveBits signature={view.envelope.signature} />
                </div>
              </div>
            </Step>
            <Step
              n={3}
              title="The public key"
              why={
                <>
                  Published at{" "}
                  <a href="/.well-known/dogfood-keys.json" className="rounded-xs underline underline-offset-4">
                    /.well-known/dogfood-keys.json
                  </a>{" "}
                  as a JWK; the private half never leaves the portal&rsquo;s database. Save the key once, and later checks need no network.
                </>
              }
            >
              <pre className={bytesBox}>
                {key ? JSON.stringify({ kid: key.kid, kty: key.kty, crv: key.crv, x: key.x }) : "This record's key is not published by this portal."}
              </pre>
            </Step>
            <Step
              n={4}
              title="Check it without this page"
              why={
                <>
                  With Node 22 or newer and the portal&rsquo;s repository, or paste the downloaded record into{" "}
                  <a href="/verify" className="rounded-xs underline underline-offset-4">
                    the verify page
                  </a>
                  .
                </>
              }
            >
              <pre className={bytesBox}>
                <span className="select-none text-ink-3">$ </span>node scripts/verify-record.mjs {rec.issuer}/records/{rec.id}
              </pre>
            </Step>
            <Step n={5} title="Try to forge it" why="Change one letter of the name in a copy of the record and run the same check on the copy. The copy never leaves this page.">
              <ForgeTry envelope={view.envelope} />
            </Step>
          </ol>
        </section>
      </div>
      </RecordCheck>
    </PublicShell>
  );
}
