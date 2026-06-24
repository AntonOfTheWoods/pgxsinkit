import { Column, is, SQL } from "drizzle-orm";

/** The `{ fieldKey: Column | SQL | nested }` map carried on a Drizzle select at `query._.selectedFields`. */
export type SelectedFields = Record<string, unknown>;

/**
 * Map a raw PGlite live-query row onto a Drizzle select's field keys.
 *
 * `useLiveDrizzleRows` feeds the builder's `.toSQL()` straight into PGlite's `live.query`, which
 * returns rows keyed by the **underlying column names** (snake_case) — `select({ assigneeId })`
 * produces SQL `select "assignee_id"`, so the raw row is `{ assignee_id }`, not `{ assigneeId }`.
 * Drizzle's own execution would remap these by position; the live query bypasses that, so this does it
 * by name using the select's field metadata:
 *
 * - a {@link Column} carries its DB `name`, so the value is read from `row[column.name]`;
 * - an {@link SQL} / aliased expression is aliased to its key in the generated SQL, so read `row[key]`;
 * - a nested selection object recurses;
 * - with no field map (a raw query) the row is returned unchanged.
 */
export function remapLiveRow(
  selectedFields: SelectedFields | undefined,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (selectedFields == null) return row;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(selectedFields)) {
    if (is(field, Column)) {
      out[key] = row[field.name];
    } else if (is(field, SQL) || is(field, SQL.Aliased)) {
      out[key] = row[key];
    } else if (field != null && typeof field === "object") {
      out[key] = remapLiveRow(field as SelectedFields, row);
    } else {
      out[key] = row[key];
    }
  }
  return out;
}
