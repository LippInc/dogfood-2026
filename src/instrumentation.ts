// Next calls register() once per server start, before the first request is served.
// The database work runs only in the Node.js runtime and never during `next build`.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { bootOrExit } = await import("./server/boot");
  await bootOrExit();
}
