import { defineConfig } from "drizzle-kit";

// Migrations are generated at development time (npm run db:generate) and applied
// at every boot by src/server/db/migrate.ts; the image never runs drizzle-kit.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
});
