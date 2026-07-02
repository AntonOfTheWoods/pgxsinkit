import { sql, type SQL } from "drizzle-orm";

/**
 * The canonical microsecond-clock SQL expression — `clock_timestamp()` epoch microseconds as BIGINT.
 * One spelling, shared by every column DEFAULT in the workspace schemas and by the PL/pgSQL
 * apply-function generator (which embeds {@link NOW_MICROSECONDS_SQL_TEXT} verbatim), so the
 * expression can never drift between surfaces and drizzle-kit snapshots stay stable.
 */
export const NOW_MICROSECONDS_SQL_TEXT = "CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)";

/** {@link NOW_MICROSECONDS_SQL_TEXT} as a Drizzle fragment, for `.default(...)` column positions. */
export const nowMicrosecondsSql: SQL = sql.raw(NOW_MICROSECONDS_SQL_TEXT);
