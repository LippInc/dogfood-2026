import { Refusal } from "@/components/refusal";

export default function Unauthorized() {
  return (
    <Refusal code="401 · Sign in needed" title="Sign in to continue" signIn>
      Only signed-in people can see this page. Sign in, and you come straight back here.
    </Refusal>
  );
}
