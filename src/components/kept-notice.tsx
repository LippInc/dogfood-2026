import Link from "next/link";

/**
 * The one line where the portal collects something about a person (the sign-up form, the comment box, a ballot):
 * what it keeps, in a sentence, and a link to the /privacy page that lists the rest (src/lib/privacy-facts.ts).
 */
export function KeptNotice({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`text-13 text-ink-3 ${className}`}>
      {children}{" "}
      <Link href="/privacy" className="whitespace-nowrap text-ink-2 underline decoration-edge underline-offset-4 hover:decoration-ink">
        What we keep
      </Link>
    </p>
  );
}
