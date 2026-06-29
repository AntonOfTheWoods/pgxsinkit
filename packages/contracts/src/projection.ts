import type { AnyPgTable } from "drizzle-orm/pg-core";

import { fingerprintReadContract } from "./fingerprint";
import type { ClientProjectionSpecForTable, SyncTableEntry, SyncTableRegistry } from "./registry";

/**
 * Per-client mode projection (ADR-0025). The authoritative (server) registry defines a table once with
 * its full write contract; a client that must only *read* that table consumes the same entry through
 * `asReadonly`. The read/identity contract — table, columns, primary key, synced-table name, column
 * omission, and the shape/row filter — is preserved verbatim; the write-capability metadata is dropped:
 *
 * - `mode` flips to `readonly`;
 * - the overlay-merged read-model `view` and the overlay/journal client projection (the local write
 *   machinery `@pgxsinkit/client` provisions for a writable table) are removed — a readonly client reads
 *   the synced base table directly;
 * - `conflictPolicy`, `governance` (managed fields), and `writeMode` are removed — a readonly table has
 *   no write path, and `defineSyncRegistry` would otherwise still treat them as a writable declaration.
 *
 * The result is the same entry `defineSyncTable` would have produced for this table with
 * `mode: "readonly"`, so `defineSyncRegistry` accepts it without the writable-table requirements
 * (server-version field + `conflictPolicy`).
 *
 * Lifecycle axes (`consistencyGroup`, `subscription`, `retention`) are preserved — a projection may keep
 * the authoritative grouping/timing/durability; change them on the projected entry if a client needs to.
 *
 * NOTE: if a new *read-relevant* field is added to {@link SyncTableEntry}, carry it here too (this builds
 * the readonly entry by listing what to keep, so a new field is otherwise silently dropped).
 */
export function asReadonly<TTable extends AnyPgTable, TLocalTable extends AnyPgTable>(
  entry: SyncTableEntry<TTable, TLocalTable>,
): SyncTableEntry<TTable, TLocalTable> {
  const { clientProjection } = entry;
  const readonlyProjection: ClientProjectionSpecForTable<TTable> | undefined =
    clientProjection != null
      ? {
          ...(clientProjection.syncedTable != null ? { syncedTable: clientProjection.syncedTable } : {}),
          ...(clientProjection.omitColumns != null ? { omitColumns: clientProjection.omitColumns } : {}),
          ...(clientProjection.localPrimaryKey != null ? { localPrimaryKey: clientProjection.localPrimaryKey } : {}),
        }
      : undefined;

  return {
    table: entry.table,
    localTable: entry.localTable,
    mode: "readonly",
    primaryKey: entry.primaryKey,
    ...(entry.shape != null ? { shape: entry.shape } : {}),
    ...(readonlyProjection != null ? { clientProjection: readonlyProjection } : {}),
    ...(entry.serverProjection != null ? { serverProjection: entry.serverProjection } : {}),
    ...(entry.consistencyGroup != null ? { consistencyGroup: entry.consistencyGroup } : {}),
    ...(entry.subscription != null ? { subscription: entry.subscription } : {}),
    ...(entry.retention != null ? { retention: entry.retention } : {}),
  };
}

/**
 * Assert that a per-client `projection` registry preserves the **read contract** (ADR-0025) of the
 * `authoritative` registry it projects from. For every table the projection declares, its
 * {@link fingerprintReadContract} must equal the authoritative entry's: a projection may differ only in
 * write capability and lifecycle orchestration, never in the data it syncs (columns, primary key,
 * row-filter shape). A table present in the authoritative registry but absent from the projection is a
 * permitted subset; a table in the projection with no authoritative source is an error (no contract to
 * project from).
 *
 * Throws, naming the divergent tables, on any mismatch. Call it where the client registries are assembled
 * (module-eval or a test) so a drifted projection fails closed instead of silently serving different rows
 * to different clients. The `customWhere` body is invisible to the fingerprint — bump
 * {@link RowFilterSpec.revision} so a logic-only divergence is caught.
 */
export function assertReadContractPreserved(
  authoritative: SyncTableRegistry,
  projection: SyncTableRegistry,
  options?: { label?: string },
): void {
  const divergent: string[] = [];

  for (const [key, projectedEntry] of Object.entries(projection)) {
    const authoritativeEntry = authoritative[key];
    if (authoritativeEntry == null) {
      divergent.push(`${key} (absent from the authoritative registry)`);
      continue;
    }
    if (fingerprintReadContract(authoritativeEntry) !== fingerprintReadContract(projectedEntry)) {
      divergent.push(key);
    }
  }

  if (divergent.length > 0) {
    const where = options?.label ? ` (${options.label})` : "";
    throw new Error(
      `read-contract divergence${where}: a per-client projection must preserve its authoritative table's ` +
        `read contract (synced columns, primary key, row-filter shape) and differ only in write capability ` +
        `and lifecycle. Divergent tables: ${divergent.join(", ")}.`,
    );
  }
}
