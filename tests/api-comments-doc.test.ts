import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "@/server/openapi";

// A hidden comment's placeholder (its place and the reason) reaches only the event's organizers and the comment's
// author; everyone else gets one comment fewer (src/server/dal/comments.ts, listComments). The API reference on
// /api-docs and the route's own doc comment said hidden comments keep their place for everyone.

const op = OPERATIONS.find((o) => o.method === "GET" && o.path === "/api/projects/{project}/comments")!;
const words = `${op.summary} ${op.note ?? ""}`;

describe("the API reference says who sees a hidden comment's placeholder", () => {
  it("names the organizers and the author, and that others get one comment fewer", () => {
    expect(words).toMatch(/organizers/);
    expect(words).toMatch(/author/);
    expect(words).toMatch(/one comment fewer/);
  });

  it("no longer says hidden comments keep their place for everyone", () => {
    expect(words).not.toMatch(/hidden ones keep their place and reason/);
    const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/projects/[project]/comments/route.ts"), "utf8");
    expect(route).not.toMatch(/hidden ones keep their place with the reason, never their text/);
    expect(route).toMatch(/one comment fewer/);
  });
});
