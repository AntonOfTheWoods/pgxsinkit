import { defineConfig } from "drizzle-kit";

// The board demo runs on its own (partial) Supabase stack with its own database, so its migration
// history is separate from the toolkit demo/harness migrations in `infra/drizzle`. Schema is the
// board registry's server tables (RLS policies travel with them via drizzle `pgPolicy`).
export default defineConfig({
  dialect: "postgresql",
  schema: ["./packages/board-schema/src/schema.ts"],
  out: "./infra/board-drizzle",
  dbCredentials: {
    url: process.env["BOARD_DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable",
  },
});
