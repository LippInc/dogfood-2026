import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { Face } from "@/components/face";
import { WorkShell } from "@/components/shell/work-shell";
import { formatUtc } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getJudgeConsole } from "@/server/dal";
import { JudgeConsoleView } from "./console";
import { KeysButton } from "./keys-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Judging" };

export default async function JudgePage({ params, searchParams }: PageProps<"/judge/[event]">) {
  const { event: key } = await params;
  const { project } = await searchParams;
  const actor = await currentActor();
  if (!actor) unauthorized();
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
  const closes = data.event.judgingCloseAt
    ? `Judging closes ${formatUtc(data.event.judgingCloseAt, { weekday: true })}`
    : data.event.resultsPublishedAt
      ? `Results published ${formatUtc(data.event.resultsPublishedAt)}`
      : "Judging stays open until the organizers publish results";
  return (
    <WorkShell
      eventName={data.event.name}
      eventHref={`/events/${data.event.slug}`}
      crumb="Judging"
      tools={
        <>
          <span className="hidden text-13 whitespace-nowrap text-ink-2 xl:inline">{closes}</span>
          <KeysButton />
        </>
      }
      person={actor.name}
      role="Judge"
      flush
    >
      <JudgeConsoleView data={data} faces={faces} startProject={typeof project === "string" ? project : null} />
    </WorkShell>
  );
}
