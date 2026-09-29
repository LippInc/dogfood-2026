// A made-up route handler for tests/api-statuses.test.ts: the status reader must find every answer below, including
// the ones reached only through a helper and a DAL error class. Not under src/app, so no route serves it.
import { ConflictError, HttpError } from "@/server/errors";
import { json, route } from "@/server/http";

const gone = () => new HttpError(410, "gone", "Gone.");

function check(n: number) {
  if (n > 2) throw new ConflictError("too_many", "Too many.");
  if (n < 0) throw gone();
}

export async function POST(req: Request) {
  return route(async () => {
    const n = Number(new URL(req.url).searchParams.get("n"));
    check(n);
    return json({ n }, n === 1 ? 202 : 200);
  });
}
