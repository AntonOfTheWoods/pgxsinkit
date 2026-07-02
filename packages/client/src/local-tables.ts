import type { ColumnBuilderBase } from "drizzle-orm";
import { getColumns } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  getTableConfig,
  integer,
  pgSchema,
  pgTable,
  pgView,
  text,
  uuid,
  varchar,
  type AnyPgTable,
  type PgColumn,
} from "drizzle-orm/pg-core";

import { getSyncRegistrySchema, type SyncTableEntry, type SyncTableRegistry } from "@pgxsinkit/contracts";

import { LOCAL_META_TABLE } from "./schema";

/**
 * Runtime Drizzle objects for the GENERATED local-store relations (ADR-0004): the per-writable-table
 * overlay (`<t>_overlay`), journal (`<t>_mutations`), sync-state view (`<t>_sync_state`), the projected
 * synced read cache, and the `pgxsinkit_local_meta` key/value table. The schema generator
 * (`schema.ts`) remains the one authority for the DDL — these objects exist so the mutation runtime,
 * consumers, and tests can AUTHOR queries against those relations as tier-① Drizzle objects
 * (rename-safe, type-checked) instead of hand-written SQL strings.
 *
 * They are query-authoring objects only — never feed them to drizzle-kit generation; the generated
 * DDL in `schema.ts` is the source of truth for the physical shape, and `local-tables.test`-level
 * coverage (the existing overlay/journal suites run against generator-provisioned stores) is what
 * keeps the two aligned.
 */

/**
 * Microsecond/bigint columns the mutation runtime handles as **strings** (the JSON-safe form it has
 * always used): passthrough both ways, `bigint` in DDL position. Reads through the raw `MutationDb`
 * seam bypass drizzle result mapping anyway; this keeps `.values()`/`.set()` accepting the runtime's
 * string values without a lossy JS-number hop.
 */
const bigintText = customType<{ data: string; driverData: string }>({
  dataType() {
    return "bigint";
  },
});

function buildJournalFixedColumns() {
  return {
    mutationId: uuid("mutation_id").primaryKey(),
    entityKeyJson: text("entity_key_json").notNull(),
    mutationSeq: integer("mutation_seq").notNull(),
    mutationKind: varchar("mutation_kind", { length: 24 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    registryVersion: text("registry_version"),
    baseServerVersion: bigintText("base_server_version"),
    writeUnit: text("write_unit"),
    writeMode: varchar("write_mode", { length: 24 }),
    payloadJson: text("payload_json").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    lastHttpStatus: integer("last_http_status"),
    conflictReason: text("conflict_reason"),
    serverUpdatedAtUs: bigintText("server_updated_at_us"),
    enqueuedAtUs: bigintText("enqueued_at_us").notNull(),
    nextRetryAtUs: bigintText("next_retry_at_us"),
    sentAtUs: bigintText("sent_at_us"),
    ackedAtUs: bigintText("acked_at_us"),
    updatedAtUs: bigintText("updated_at_us").notNull(),
  };
}

function buildOverlayFixedColumns() {
  return {
    overlayKind: varchar("overlay_kind", { length: 24 }).notNull(),
    localUpdatedAtUs: bigintText("local_updated_at_us").notNull(),
  };
}

function buildSyncStateFixedColumns() {
  return {
    observedServerVersion: bigint("observed_server_version", { mode: "bigint" }),
    ackedServerVersion: bigint("acked_server_version", { mode: "bigint" }),
    pendingCount: bigint("pending_count", { mode: "number" }).notNull(),
    hasAckedUnobservedWrite: boolean("has_acked_unobserved_write").notNull(),
    localDeletePending: boolean("local_delete_pending").notNull(),
    conflictState: text("conflict_state"),
    quarantinedCount: bigint("quarantined_count", { mode: "number" }).notNull(),
    quarantineState: text("quarantine_state"),
  };
}

// Phantom shape tables: never created, never queried — they exist only so the exported table types
// carry strong typing on the FIXED column keys while the per-entry primary-key columns (dynamic by
// construction) ride the index signature. The bracket access that implies at call sites is the
// convention for genuinely-dynamic keys.
const journalShape = pgTable("_pgxsinkit_journal_shape", buildJournalFixedColumns());
const overlayShape = pgTable("_pgxsinkit_overlay_shape", buildOverlayFixedColumns());
const syncStateShape = pgView("_pgxsinkit_sync_state_shape", buildSyncStateFixedColumns()).existing();
const localMetaShape = pgTable(LOCAL_META_TABLE, {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** The `<t>_mutations` journal: fixed runtime columns + the entry's PK columns (index-signature access). */
export type JournalTable = typeof journalShape & { [columnName: string]: PgColumn };
/** The `<t>_overlay` table: the entry's projected columns (index-signature access) + the two overlay columns. */
export type OverlayTable = typeof overlayShape & { [columnName: string]: PgColumn };
/** The `<t>_sync_state` convergence view (ADR-0011): fixed state columns + the entry's PK columns. */
export type SyncStateView = typeof syncStateShape & { [columnName: string]: PgColumn };
/** The `pgxsinkit_local_meta` key/value table (ADR-0006). */
export type LocalMetaTable = typeof localMetaShape;

function makeTable(localSchema: string, name: string, columns: Record<string, ColumnBuilderBase>): AnyPgTable {
  return localSchema === "public" ? pgTable(name, columns) : pgSchema(localSchema).table(name, columns);
}

function resolveSyncedTableName(entry: SyncTableEntry<AnyPgTable>): string {
  return entry.clientProjection?.syncedTable ?? getTableConfig(entry.table).name;
}

/**
 * The entry's projected column BUILDERS keyed by property key, re-created from the retained
 * `makeColumns` factory (registry.ts keeps it for exactly this kind of reuse) with
 * `clientProjection.omitColumns` applied — the same projection the generator's synced/overlay DDL
 * carries.
 */
function projectedColumnBuilders(entry: SyncTableEntry<AnyPgTable>, tableKey: string) {
  const makeColumns = entry.makeColumns;
  if (!makeColumns) {
    throw new Error(
      `local table objects for ${tableKey} need the entry's makeColumns factory (built by defineSyncTable); ` +
        `hand-assembled entries cannot derive overlay/journal objects`,
    );
  }
  const omitted = new Set(entry.clientProjection?.omitColumns ?? []);
  return Object.fromEntries(Object.entries(makeColumns()).filter(([key]) => !omitted.has(key))) as Record<
    string,
    ColumnBuilderBase
  >;
}

/** Property-key ↔ column-name pairs for the entry's PK, resolved via the built local table. */
function pkColumnPairs(entry: SyncTableEntry<AnyPgTable>, tableKey: string) {
  const localColumns = getColumns(entry.localTable) as Record<string, PgColumn>;
  return entry.primaryKey.columns.map((columnName) => {
    const pair = Object.entries(localColumns).find(([, column]) => column.name === columnName);
    if (!pair) {
      throw new Error(`Primary key column ${columnName} was not found on table ${tableKey}`);
    }
    return { propertyKey: pair[0], columnName };
  });
}

interface EntryLocalTables {
  synced?: AnyPgTable;
  overlay?: OverlayTable;
  journal?: JournalTable;
  syncState?: SyncStateView;
}

const localTablesCache = new WeakMap<SyncTableRegistry, Map<string, EntryLocalTables>>();
const localMetaCache = new Map<string, LocalMetaTable>();

function cacheFor(registry: SyncTableRegistry, tableKey: string): EntryLocalTables {
  let byKey = localTablesCache.get(registry);
  if (!byKey) {
    byKey = new Map();
    localTablesCache.set(registry, byKey);
  }
  let slot = byKey.get(tableKey);
  if (!slot) {
    slot = {};
    byKey.set(tableKey, slot);
  }
  return slot;
}

function requireEntry(registry: SyncTableRegistry, tableKey: string): SyncTableEntry<AnyPgTable> {
  const entry = registry[tableKey];
  if (!entry) {
    throw new Error(`Unknown sync table: ${tableKey}`);
  }
  return entry;
}

function requireWritable(entry: SyncTableEntry<AnyPgTable>, tableKey: string, relation: string) {
  if (!entry.clientProjection?.overlayTable || !entry.clientProjection.journalTable) {
    throw new Error(`${relation} exists only for a writable table; ${tableKey} has no overlay/journal projection`);
  }
  return entry.clientProjection as { overlayTable: string; journalTable: string; syncedTable?: string };
}

/**
 * The projected SYNCED read-cache table as a runtime Drizzle object, under the resolved local name
 * (`clientProjection.syncedTable` override honoured) and the registry's local schema — the exact
 * relation the generator's `CREATE TABLE` provisions. Prefer `entry.localTable` where its name
 * already matches; this object exists for the runtime/tests that must track the projection rename.
 */
export function getSyncedLocalTable<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  tableKey: string & keyof TRegistry,
): AnyPgTable {
  const slot = cacheFor(registry, tableKey);
  if (slot.synced) {
    return slot.synced;
  }
  const entry = requireEntry(registry, tableKey);
  const localSchema = getSyncRegistrySchema(registry);
  const table = makeTable(
    localSchema,
    resolveSyncedTableName(entry),
    projectedColumnBuilders(entry, tableKey) as Record<string, ColumnBuilderBase>,
  );
  slot.synced = table;
  return table;
}

/** The `<t>_overlay` optimistic-intent table as a runtime Drizzle object. */
export function getOverlayTable<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  tableKey: string & keyof TRegistry,
): OverlayTable {
  const slot = cacheFor(registry, tableKey);
  if (slot.overlay) {
    return slot.overlay;
  }
  const entry = requireEntry(registry, tableKey);
  const projection = requireWritable(entry, tableKey, "the overlay table");
  const localSchema = getSyncRegistrySchema(registry);
  const table = makeTable(localSchema, projection.overlayTable, {
    ...(projectedColumnBuilders(entry, tableKey) as Record<string, ColumnBuilderBase>),
    ...buildOverlayFixedColumns(),
  }) as OverlayTable;
  slot.overlay = table;
  return table;
}

/** The `<t>_mutations` journal table as a runtime Drizzle object. */
export function getJournalTable<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  tableKey: string & keyof TRegistry,
): JournalTable {
  const slot = cacheFor(registry, tableKey);
  if (slot.journal) {
    return slot.journal;
  }
  const entry = requireEntry(registry, tableKey);
  const projection = requireWritable(entry, tableKey, "the journal table");
  const localSchema = getSyncRegistrySchema(registry);
  const pkBuilders = Object.fromEntries(
    pkColumnPairs(entry, tableKey).map(({ columnName }) => [columnName, text(columnName).notNull()]),
  );
  const table = makeTable(localSchema, projection.journalTable, {
    ...pkBuilders,
    ...buildJournalFixedColumns(),
  }) as JournalTable;
  slot.journal = table;
  return table;
}

/**
 * The `<t>_sync_state` convergence view (ADR-0011) as a runtime Drizzle object — PK columns under the
 * entry's own property keys plus the fixed state columns, mirroring `buildSyncStateView`'s projection.
 */
export function getSyncStateView<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  tableKey: string & keyof TRegistry,
): SyncStateView {
  const slot = cacheFor(registry, tableKey);
  if (slot.syncState) {
    return slot.syncState;
  }
  const entry = requireEntry(registry, tableKey);
  requireWritable(entry, tableKey, "the sync-state view");
  const localSchema = getSyncRegistrySchema(registry);
  const viewName = `${resolveSyncedTableName(entry)}_sync_state`;
  const builders = projectedColumnBuilders(entry, tableKey);
  const pkBuilders = Object.fromEntries(
    pkColumnPairs(entry, tableKey).map(({ propertyKey }) => {
      const builder = builders[propertyKey];
      if (!builder) {
        throw new Error(`Primary key property ${propertyKey} was not found on table ${tableKey}`);
      }
      return [propertyKey, builder];
    }),
  ) as Record<string, ColumnBuilderBase>;
  const columns = {
    ...(pkBuilders as Record<string, ColumnBuilderBase>),
    ...buildSyncStateFixedColumns(),
  };
  const view = (
    localSchema === "public"
      ? pgView(viewName, columns).existing()
      : pgSchema(localSchema).view(viewName, columns).existing()
  ) as SyncStateView;
  slot.syncState = view;
  return view;
}

/** The `pgxsinkit_local_meta` key/value table (ADR-0006) under the registry's local schema. */
export function getLocalMetaTable(registry: SyncTableRegistry): LocalMetaTable {
  const localSchema = getSyncRegistrySchema(registry);
  const cached = localMetaCache.get(localSchema);
  if (cached) {
    return cached;
  }
  const table = makeTable(localSchema, LOCAL_META_TABLE, {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
  }) as LocalMetaTable;
  localMetaCache.set(localSchema, table);
  return table;
}
