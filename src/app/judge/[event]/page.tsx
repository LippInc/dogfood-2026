import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { Face } from "@/components/face";
import { WorkShell } from "@/components/shell/work-shell";
import { formatUtc } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getJudgeConsole, getPairwiseState, myRecords, type Actor, type PairwiseState } from "@/server/dal";
import { openOwnRecord } from "../../records/actions";
import { CompareView } from "./compare";
import { JudgeConsoleView } from "./console";
import { KeysButton } from "./keys-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Judging" };

export default async function JudgePage({ params, searchParams }: PageProps<"/judge/[event]">) {
  const { event: key } = await params;
  const { project } = await searchParams;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const pairwise = guardPage(() => getPairwiseState(actor, key));
  if (pairwise.mode === "pairwise") return <ComparePage actor={actor} state={pairwise} />;
  const data = guardPage(() => getJudgeConsole(actor, key));
  const faces = Object.fromEntries(
    data.items.map((i) => [
      i.project.id,
      {
        small: <Face id={i.project.id} cols={32} rows={18} className="block h-[27px] w-12" />,
        large: <Face id={i.project.id} cols={48} rows={27} className="block h-[72px] w-32" />,
      },
    ]),
  );
  return (
    <WorkShell
      eventName={data.event.name}
      eventHref={`/events/${data.event.slug}`}
      crumb="Judging"
      tools={<JudgeTools actor={actor} event={data.event} judged={data.items.some((i) => i.status === "done")} keys />}
      person={actor.name}
      role="Judge"
      flush
    >
      <JudgeConsoleView data={data} faces={faces} startProject={typeof project === "string" ? project : null} />
    </WorkShell>
  );
}

/** Pairwise mode: the same frame with the Compare screen inside. */
function ComparePage({ actor, state }: { actor: Actor; state: PairwiseState }) {
  const ids = new Set(state.tracks.flatMap((t) => t.projects.map((p) => p.id)));
  const faces = Object.fromEntries(
    [...ids].map((id) => [
      id,
      {
        small: <Face id={id} cols={32} rows={18} className="block h-[27px] w-12" />,
        // a 3:1 band, drawn at that shape (not stretched), so both cards and all three answers fit a 900 px screen
        large: <Face id={id} cols={48} rows={16} className="block h-full w-full" />,
      },
    ]),
  );
  return (
    <WorkShell
      eventName={state.event.name}
      eventHref={`/events/${state.event.slug}`}
      crumb="Judging"
      // once answers are final no key answers anything, so the keys are not offered
      tools={<JudgeTools actor={actor} event={state.event} judged={state.tracks.some((t) => t.answered > 0)} keys={!state.readOnly} />}
      person={actor.name}
      role="Judge"
      flush
    >
      <CompareView initial={state} faces={faces} />
    </WorkShell>
  );
}

type JudgeEvent = { slug: string; judgingCloseAt: string | null; resultsPublishedAt: string | null };

/**
 * The judge's toolbar, the same in both modes: when judging closes, the signed judging record once results are
 * published (a link when it exists, else the button that makes it, for a judge who did some judging), and the
 * keyboard keys when `keys`.
 */
function JudgeTools({ actor, event, judged, keys }: { actor: Actor; event: JudgeEvent; judged: boolean; keys: boolean }) {
  const closes = event.judgingCloseAt
    ? `Judging closes ${formatUtc(event.judgingCloseAt, { weekday: true })}`
    : event.resultsPublishedAt
      ? `Results published ${formatUtc(event.resultsPublishedAt)}`
      : "Judging stays open until the organizers publish results";
  const record = event.resultsPublishedAt ? myRecords(actor, event.slug).find((r) => r.kind === "judge") : undefined;
  const recordButton = "inline-flex h-8 items-center rounded-sm border border-edge px-3 text-13 font-medium whitespace-nowrap hover:bg-raised";
  return (
    <>
      <span className="hidden text-13 whitespace-nowrap text-ink-2 xl:inline">{closes}</span>
      {record ? (
        <Link href={`/records/${record.id}`} className={recordButton}>
          Your judging record
        </Link>
      ) : event.resultsPublishedAt && judged ? (
        <form action={openOwnRecord.bind(null, event.slug, "judge")}>
          {/* on phones the long label pushed Sign out onto a line of its own; the name is the visible label at each width (WCAG 2.5.3) */}
          <button className={recordButton}>
            <span className="sm:hidden">Get your record</span>
            <span className="max-sm:hidden">Get your signed judging record</span>
          </button>
        </form>
      ) : null}
      {keys ? <KeysButton /> : null}
    </>
  );
}
