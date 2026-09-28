import Link from "next/link";
import { PlainBand, PlainMark } from "@/components/shell/plain-shell";
import { AskedPath, StatusSheet } from "@/components/status-sheet";
import { buttonVariants } from "@/components/ui/button";
import { LookAlikes } from "./look-alikes";

/** A record id this portal never issued: still a real 404, with what to check on this kind of link. */
export default function NotFound() {
  return (
    <StatusSheet
      code="404 · No such record"
      title="This portal holds no record with this id"
      lead={
        <>
          <p>
            A record&rsquo;s address ends in <span className="font-mono text-15">rec_</span> and 16 letters and digits, and ids never use <span className="font-mono text-15">0</span>, <span className="font-mono text-15">o</span>,{" "}
            <span className="font-mono text-15">1</span> or <span className="font-mono text-15">l</span>, so
            a copy read off paper can be checked for those. Each portal serves only the records it signed: a record from another portal opens there.
          </p>
          <LookAlikes />
        </>
      }
      status="404"
      mark={<PlainMark extra="404" />}
      band={<PlainBand />}
      spoil={{ hollow: [1] }}
      rows={[
        { label: "Asked for", value: <AskedPath />, mono: true },
        { label: "Looked in", value: "The signed records this portal issued" },
        { label: "Answer", value: "HTTP 404, sent as a real status, never a redirect" },
      ]}
      actions={
        <Link href="/verify" className={buttonVariants({ size: "lg", className: "max-sm:h-11" })}>
          Check a record file instead
        </Link>
      }
      steps={[
        { href: "/", head: "The projects", body: "The events on this portal, their projects and, once published, their results." },
        { href: "/api-docs", head: "The API", body: "Everything the interface does, as JSON, for scripts and integrations." },
      ]}
    />
  );
}
