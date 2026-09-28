import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${root}src/` },
      // Next swaps "server-only" out in server bundles; the tests run server code directly.
      { find: /^server-only$/, replacement: `${root}tests/support/server-only.ts` },
    ],
  },
  test: {
    environment: "node",
    pool: "forks",
    // Room for a machine that is also building images and rendering video: two tests that take about a second
    // alone ran 8 to 9 s under that load and failed at the 5 s default (2026-09-28).
    testTimeout: 30_000,
    // The Monte Carlo proofs keep every core busy for a minute or more; run them after the
    // rest, so tests that time real work (argon2, a local webhook receiver) never share the
    // machine with them. `vitest run` still runs both groups.
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/**/*.test.ts"], exclude: [...configDefaults.exclude, "tests/**/*-mc.test.ts"], sequence: { groupOrder: 0 } },
      },
      { extends: true, test: { name: "monte-carlo", include: ["tests/**/*-mc.test.ts"], sequence: { groupOrder: 1 } } },
    ],
  },
});
