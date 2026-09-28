import "server-only";

// The first request to each page or route loads its code and renders cold: on a busy laptop the first gallery
// request once took over 10 s, the acceptance checker's timeout, while warm ones take about 0.05 s. So once boot
// is done the portal asks itself for what a visitor and the checker ask first, and only then prints "portal
// ready" and lets /api/health answer 200. Every warm-up request is anonymous and reads only: the pages are public,
// and each API route answers 401 before it looks at anything, so no audit row is written and no limit is spent.
// It runs after register() has returned (Next serves no request before that), never during `next build`.

const WARMING = Symbol.for("dogfood.portal-warming");
const store = globalThis as typeof globalThis & { [WARMING]?: true };

/** True between the end of boot and the end of the warm-up; /api/health answers 503 meanwhile. */
export function warmingUp(): boolean {
  return store[WARMING] === true;
}

export type WarmStep = { method: "GET" | "POST"; path: string };

/** What the portal requests from itself, in the order the acceptance checker first meets them. */
export function warmUpSteps(event: { id: string; slug: string } | null): WarmStep[] {
  if (!event) return [{ method: "GET", path: "/" }, { method: "GET", path: "/sign-up" }, { method: "GET", path: "/api/health" }];
  return [
    { method: "GET", path: `/events/${event.slug}` },
    { method: "POST", path: `/api/events/${event.id}/projects` },
    { method: "GET", path: "/api/judge/scores" },
    { method: "GET", path: `/api/events/${event.id}/export/scores.csv` },
    { method: "GET", path: "/" },
    { method: "GET", path: "/sign-in" },
    { method: "GET", path: "/api/health" },
  ];
}

export type WarmResult = { path: string; method: string; status: number | null; ms: number };

/** How long to keep trying to reach the server at all, and how long one request may take. */
const CONNECT_FOR_MS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000;

async function once(base: string, step: WarmStep, fetchImpl: typeof fetch): Promise<WarmResult> {
  const started = Date.now();
  const deadline = started + CONNECT_FOR_MS;
  for (;;) {
    try {
      const res = await fetchImpl(base + step.path, {
        method: step.method,
        headers: step.method === "POST" ? { "content-type": "application/json" } : undefined,
        body: step.method === "POST" ? "{}" : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await res.arrayBuffer();
      return { path: step.path, method: step.method, status: res.status, ms: Date.now() - started };
    } catch {
      // not listening yet (Next opens its port as register() returns), or the request timed out
      if (Date.now() >= deadline) return { path: step.path, method: step.method, status: null, ms: Date.now() - started };
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/**
 * Request every step once, one after the other, then call done with what each took. Marks the portal as warming
 * until done has run, whatever happens: a step that fails is reported, never retried forever.
 */
export async function warmUp(base: string, steps: WarmStep[], done: (results: WarmResult[]) => void, fetchImpl: typeof fetch = fetch): Promise<void> {
  store[WARMING] = true;
  const results: WarmResult[] = [];
  try {
    for (const step of steps) results.push(await once(base, step, fetchImpl));
  } finally {
    delete store[WARMING];
    done(results);
  }
}

/** The address the server listens on, from inside: Next's standalone server and `next start` read PORT. */
export function selfBase(port: string | undefined = process.env.PORT): string {
  return `http://127.0.0.1:${port || "3000"}`;
}
