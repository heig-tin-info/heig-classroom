import { defineConfig } from "drizzle-kit";

/**
 * SQLite migrations. `pnpm --filter @hgc/codespace exec drizzle-kit generate`
 * writes into `drizzle/`; `db/client.ts` applies them when opening the base.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env["DATABASE_PATH"] ?? "./var/codespace.sqlite",
  },
});
