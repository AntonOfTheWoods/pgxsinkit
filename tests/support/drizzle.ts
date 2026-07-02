import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

// One drizzle handle per PGlite instance, so every converted call site in a file shares a builder
// without re-wrapping. Wrapping is cheap, but a single identity also keeps `.toSQL()`-rendered
// statements comparable across helpers.
const handles = new WeakMap<PGlite, PgliteDatabase<never>>();

/** A (memoized) Drizzle handle over any test PGlite instance — the tier-① authoring surface. */
export function drizzleOver(pg: PGlite): PgliteDatabase<never> {
  let db = handles.get(pg);
  if (!db) {
    // MUST be the `{ client }` config form: drizzle's pglite driver destructures `{ connection, client }`
    // from a bare first argument, so `drizzle(pg)` misdetects the instance as a config and silently
    // constructs a NEW in-memory PGlite — every read would then target an empty database.
    db = drizzle({ client: pg as never }) as PgliteDatabase<never>;
    handles.set(pg, db);
  }
  return db;
}

/**
 * Create the given Drizzle tables (and enums they reference) in a FRESH database by generating the
 * empty→schema migration statements offline (drizzle-kit's `generateDrizzleJson`/`generateMigration`)
 * and executing them. Deliberately NOT diff-based `pushSchema`: nothing is introspected, so this can
 * never emit statements about relations it was not given — safe for PGlite fixtures and for shared
 * integration databases alike. Only meaningful for fixture tables that do not already exist.
 */
export async function createTablesFromSchema(
  db: { execute: (query: string) => Promise<unknown> } | PGlite,
  schema: Record<string, unknown>,
): Promise<void> {
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api-postgres");
  const statements = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson(schema));
  for (const statement of statements) {
    if ("execute" in db && typeof db.execute === "function") {
      await (db as { execute: (query: string) => Promise<unknown> }).execute(statement);
    } else {
      await (db as PGlite).exec(statement);
    }
  }
}
