import { Refusal } from "@/components/refusal";

export default function Unauthorized() {
  return (
    <Refusal code="401 · Sign in needed" title="Sign in to continue" signIn>
      This page belongs to someone with an account here. Sign in, and you come straight back.
    </Refusal>
  );
}
