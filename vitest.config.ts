import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
    include: ["tests/**/*.test.ts"],
    pool: "forks",
  },
});
