import { Refusal } from "@/components/refusal";

/** A reset link nobody holds: still a real 404, with who makes a working one. */
export default function NotFound() {
  return (
    <Refusal code="404 · Not found" title="This password link does not work">
      The portal knows no reset link like this one. A new link replaces an unused one, so an older link stops working. Ask the portal&apos;s administrator
      for a new one: they make it on the Accounts page.
    </Refusal>
  );
}
