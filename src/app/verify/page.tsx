import type { Metadata } from "next";
import { PlainShell } from "@/components/shell/plain-shell";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Check a signed record" };

export default function VerifyPage() {
  return (
    <PlainShell width="max-w-[1120px]">
      <p className="label-mono text-accent-ink">Anyone can check · no account needed</p>
      <h1 className="mt-3 font-display text-38">Check a signed record</h1>
      <p className="mt-3 max-w-[640px] text-15 text-ink-2">
        Judging records and certificates from this portal are signed with its Ed25519 key. Paste a record, or open the file you downloaded:
        your browser checks the signature against the key published at{" "}
        <a href="/.well-known/dogfood-keys.json" className="underline underline-offset-4">
          /.well-known/dogfood-keys.json
        </a>
        , and the portal checks it too.
      </p>
      <div className="mt-10">
        <VerifyForm />
      </div>
    </PlainShell>
  );
}
