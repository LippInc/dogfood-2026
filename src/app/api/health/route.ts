import { healthCheck, json, route } from "@/server/dal";

export const dynamic = "force-dynamic";

/** For the container healthcheck: 200 once the database answers and holds an event. */
export async function GET() {
  return route(async () => {
    const health = healthCheck();
    return json(health, health.ok ? 200 : 503);
  });
}
