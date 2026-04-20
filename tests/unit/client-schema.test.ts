import { bigint, integer, jsonb, pgEnum, pgTable, primaryKey, real, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { buildSyntheticRegistry, buildSyntheticRegistrySchemaName, demoSyncRegistry } from "@pgxsinkit/demo";

import { generateLocalSchemaSql } from "../../packages/client/src/schema";

const projectedClientTable = pgTable("projected_client_items", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  modifiedBy: uuid("modified_by"),
  title: varchar("title", { length: 120 }).notNull(),
  notes: varchar("notes", { length: 255 }),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
});

const readonlyStatusEnum = pgEnum("readonly_status", ["queued", "done"]);

const compositeReadonlyTable = pgTable(
  "composite_readonly_items",
  {
    id: uuid("id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    status: readonlyStatusEnum("status").notNull(),
    words: integer("words").array(),
    payload: jsonb("payload"),
    efactor: real("efactor").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.ownerId] })],
);

const fallbackReadModelTable = pgTable("fallback_read_model_items", {
  id: uuid("id").primaryKey(),
  title: varchar("title", { length: 120 }).notNull(),
});

const projectedClientRegistry = defineSyncRegistry({
  projectedItems: defineSyncTable({
    table: projectedClientTable,
    mode: "readwrite",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "projected_client_items", shapeKey: "projected_client_items" },
    clientProjection: {
      syncedTable: "projected_client_items",
      overlayTable: "projected_client_items_overlay",
      journalTable: "projected_client_items_mutations",
      readModel: "projected_client_items_read_model",
      omitColumns: ["ownerId", "modifiedBy", "notes"],
    },
    governance: {
      managedFields: [
        { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
        { column: "modifiedBy", applyOn: ["create", "update"], strategy: "authUid" },
        { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
        { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      ],
    },
  }),
});

const compositeReadonlyRegistry = defineSyncRegistry({
  compositeReadonlyItems: defineSyncTable({
    table: compositeReadonlyTable,
    mode: "readonly",
    primaryKey: { columns: ["id", "owner_id"] },
    shape: { tableName: "composite_readonly_items", shapeKey: "composite_readonly_items" },
    clientProjection: {
      syncedTable: "composite_readonly_items",
      readModel: "composite_readonly_items",
    },
  }),
});

const fallbackReadModelRegistry = defineSyncRegistry({
  fallbackReadModelItems: defineSyncTable({
    table: fallbackReadModelTable,
    mode: "readwrite",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "fallback_read_model_items", shapeKey: "fallback_read_model_items" },
    clientProjection: {
      syncedTable: "fallback_read_model_items",
      overlayTable: "fallback_read_model_items_overlay",
      journalTable: "fallback_read_model_items_mutations",
      readModel: "fallback_read_model_items_read_model",
    },
  }),
});

describe("client local schema generation", () => {
  it("generates local synced, overlay, journal, and read-model SQL from the registry", () => {
    const sql = generateLocalSchemaSql(demoSyncRegistry);

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS authors");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS author_overlay");
    expect(sql).toContain(
      "CREATE SEQUENCE IF NOT EXISTS author_mutations_mutation_seq AS integer START WITH 1 INCREMENT BY 1;",
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS author_mutations");
    expect(sql).toContain("CREATE OR REPLACE VIEW author_read_model AS");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS todos");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS todo_overlay");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS todo_mutations");
    expect(sql).toContain("CREATE OR REPLACE VIEW todo_read_model AS");
    expect(sql).toContain("entity_key_json TEXT NOT NULL");
    expect(sql).toContain(
      "mutation_seq INTEGER NOT NULL UNIQUE DEFAULT nextval('author_mutations_mutation_seq')::integer",
    );
    expect(sql).not.toContain("UNIQUE (entity_key_json, mutation_seq)");
    expect(sql).toContain("author_mutations_status_retry_idx");
    expect(sql).toContain("author_mutations_entity_status_seq_idx");
  });

  it("qualifies local tables and views when the registry schema is non-public", () => {
    const schemaName = buildSyntheticRegistrySchemaName({
      tableCount: 2,
      extraColumnCount: 8,
    });
    const { registry } = buildSyntheticRegistry({
      tableCount: 2,
      extraColumnCount: 8,
      schemaName,
    });
    const sql = generateLocalSchemaSql(registry);

    expect(sql).toContain(`CREATE SCHEMA IF NOT EXISTS "${schemaName}";`);
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${schemaName}"."perf_items_000"`);
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${schemaName}"."perf_items_000_overlay"`);
    expect(sql).toContain(
      `CREATE SEQUENCE IF NOT EXISTS "${schemaName}"."perf_items_000_mutations_mutation_seq" AS integer START WITH 1 INCREMENT BY 1;`,
    );
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${schemaName}"."perf_items_000_mutations"`);
    expect(sql).toContain(`CREATE OR REPLACE VIEW "${schemaName}"."perf_items_000_read_model" AS`);
  });

  it("omits projected-away columns from synced, overlay, and read-model SQL", () => {
    const sql = generateLocalSchemaSql(projectedClientRegistry);

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS projected_client_items");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS projected_client_items_overlay");
    expect(sql).toContain("CREATE OR REPLACE VIEW projected_client_items_read_model AS");
    expect(sql).toContain("title varchar(120) NOT NULL");
    expect(sql).not.toContain("owner_id uuid");
    expect(sql).not.toContain("modified_by uuid");
    expect(sql).not.toContain("notes varchar(255)");
  });

  it("preserves SQL column types and composite readonly primary keys", () => {
    const sql = generateLocalSchemaSql(compositeReadonlyRegistry);

    expect(sql).toContain("status readonly_status NOT NULL");
    expect(sql).toContain("words integer[]");
    expect(sql).toContain("payload jsonb");
    expect(sql).toContain("efactor real NOT NULL");
    expect(sql).toContain("PRIMARY KEY (id, owner_id)");
    expect(sql).not.toContain("id uuid NOT NULL PRIMARY KEY,");
    expect(sql).not.toContain("owner_id uuid NOT NULL PRIMARY KEY");
  });

  it("uses a valid read-model fallback when updated_at_us is absent", () => {
    const sql = generateLocalSchemaSql(fallbackReadModelRegistry);

    expect(sql).toContain("CAST(0 AS BIGINT) AS local_updated_at_us");
    expect(sql).not.toContain("CAST(0 AS BIGINT) AS local_updated_at_us AS local_updated_at_us");
    expect(sql).not.toContain("t.CAST(0 AS BIGINT)");
  });
});
