import Link from "next/link";
import { AskedPath, StatusSheet } from "@/components/status-sheet";
import { buttonVariants } from "@/components/ui/button";

/**
 * The site-wide 404. Invite, voting, reset and personal links have their own 404s in their
 * route folders; this one is for everything else: an event, a project or a record that is
 * not there, or an address with a slip in it.
 */
export default function NotFound() {
  return (
    <StatusSheet
      code="404 · Not found"
      title="Nothing lives at this address"
      lead={
        <p>
          The event, project or signed record may have been renamed or removed, or the address has a slip in it. Check
          it against the link you were sent, or start again from the projects.
        </p>
      }
      status="404"
      spoil={{ hollow: [1] }}
      rows={[
        { label: "Asked for", value: <AskedPath />, mono: true },
        { label: "Answer", value: "HTTP 404, sent as a real status, never a redirect" },
      ]}
      actions={
        <Link href="/" className={buttonVariants({ size: "lg", className: "max-sm:h-11" })}>
          Go to the projects
        </Link>
      }
      steps={[
        { href: "/verify", head: "Check a signed record", body: "Paste a certificate or a judging record and test its signature." },
        { href: "/api-docs", head: "The API", body: "Everything the interface does, as JSON, for scripts and integrations." },
      ]}
    />
  );
}
