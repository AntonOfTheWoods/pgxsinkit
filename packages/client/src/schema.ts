import type { AnyPgTable } from "drizzle-orm/pg-core";

import {
  getLocalSyncPrimaryKeyColumns,
  getSyncRegistrySchema,
  getProjectedColumns,
  type ClientProjectionSpec,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

type TableColumn = ReturnType<typeof getProjectedColumns<AnyPgTable>>[number]["column"];

export function generateLocalSchemaSql<TRegistry extends SyncTableRegistry>(registry: TRegistry) {
  const statements: string[] = [];
  const localSchema = getSyncRegistrySchema(registry);

  if (localSchema !== "public") {
    statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(localSchema)};`);
  }

  for (const [tableKey, entry] of Object.entries(registry)) {
    const projection = getClientProjection(entry, tableKey, localSchema);
    const columns = getProjectedColumns(entry).map(({ column }) => column);
    const syncedTablePrimaryKeyColumns = getLocalSyncPrimaryKeyColumns(entry);
    const baseColumnsSql = buildTableColumnSql(columns, syncedTablePrimaryKeyColumns);

    statements.push(`CREATE TABLE IF NOT EXISTS ${projection.syncedTable} (\n  ${baseColumnsSql}\n);`);

    if (entry.mode === "readonly") {
      continue;
    }

    if (!projection.overlayTable || !projection.journalTable) {
      throw new Error(`overlay and journal tables are required for writable table ${tableKey}`);
    }

    const journalTableName = entry.clientProjection?.journalTable;

    if (!journalTableName) {
      throw new Error(`journal table is required for writable table ${tableKey}`);
    }

    const primaryKeyColumns = entry.primaryKey.columns.map((columnName) => {
      const column = columns.find((candidate) => candidate.name === columnName);

      if (!column) {
        throw new Error(`Primary key column ${columnName} was not found on table ${tableKey}`);
      }

      return column;
    });
    const primaryKeyColumnNames = primaryKeyColumns.map((column) => column.name);
    const journalSequenceName = buildJournalSequenceName(journalTableName);
    const qualifiedJournalSequenceName = qualifyIdentifier(localSchema, journalSequenceName);

    statements.push(
      `CREATE TABLE IF NOT EXISTS ${projection.overlayTable} (\n  ${[
        ...columns.map((column) => buildColumnDefinition(column, primaryKeyColumnNames)),
        "overlay_kind VARCHAR(24) NOT NULL",
        "local_updated_at_us BIGINT NOT NULL",
        ...buildCompositePrimaryKeyClauses(primaryKeyColumnNames),
      ].join(",\n  ")}\n);`,
    );

    statements.push(
      `CREATE SEQUENCE IF NOT EXISTS ${qualifiedJournalSequenceName} AS integer START WITH 1 INCREMENT BY 1;`,
    );

    statements.push(
      `CREATE TABLE IF NOT EXISTS ${projection.journalTable} (\n  ${[
        "mutation_id UUID PRIMARY KEY",
        ...primaryKeyColumns.map((column) => `${column.name} ${mapColumnType(column)} NOT NULL`),
        "entity_key_json TEXT NOT NULL",
        `mutation_seq INTEGER NOT NULL UNIQUE DEFAULT nextval(${quoteSqlStringLiteral(qualifiedJournalSequenceName)})::integer`,
        "mutation_kind VARCHAR(24) NOT NULL",
        "status VARCHAR(24) NOT NULL",
        "payload_json TEXT NOT NULL",
        "attempt_count INTEGER NOT NULL DEFAULT 0",
        "last_error TEXT",
        "last_http_status INTEGER",
        "conflict_reason TEXT",
        "server_updated_at_us BIGINT",
        "enqueued_at_us BIGINT NOT NULL",
        "next_retry_at_us BIGINT",
        "sent_at_us BIGINT",
        "acked_at_us BIGINT",
        "updated_at_us BIGINT NOT NULL",
      ].join(",\n  ")}\n);`,
    );

    statements.push(
      `CREATE INDEX IF NOT EXISTS ${baseProjection(entry, tableKey).journalTable}_status_idx ON ${projection.journalTable} (status, enqueued_at_us);`,
    );
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${baseProjection(entry, tableKey).journalTable}_status_retry_idx ON ${projection.journalTable} (status, next_retry_at_us, enqueued_at_us);`,
    );
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${baseProjection(entry, tableKey).journalTable}_pk_seq_idx ON ${projection.journalTable} (${entry.primaryKey.columns.join(", ")}, mutation_seq);`,
    );
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${baseProjection(entry, tableKey).journalTable}_entity_seq_idx ON ${projection.journalTable} (entity_key_json, mutation_seq);`,
    );
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${baseProjection(entry, tableKey).journalTable}_entity_status_seq_idx ON ${projection.journalTable} (entity_key_json, status, mutation_seq);`,
    );

    statements.push(
      `CREATE OR REPLACE VIEW ${projection.readModel} AS\n${buildReadModelViewSql(
        entry,
        projection,
        columns.map((column) => column.name),
      )};`,
    );
  }

  return `${statements.join("\n\n")}\n`;
}

function buildReadModelViewSql(
  entry: SyncTableEntry<AnyPgTable>,
  projection: ClientProjectionSpec,
  columnNames: string[],
) {
  if (!projection.overlayTable) {
    throw new Error(`overlay table is required for writable table ${projection.syncedTable}`);
  }

  const pkMatch = buildPrimaryKeyMatch(entry.primaryKey.columns);
  const syncedLocalUpdatedExpression = columnNames.includes("updated_at_us") ? "t.updated_at_us" : "CAST(0 AS BIGINT)";

  return [
    "SELECT",
    `  ${columnNames.join(",\n  ")},`,
    "  overlay_kind,",
    "  local_updated_at_us",
    `FROM ${projection.overlayTable}`,
    `WHERE overlay_kind <> 'pending_delete'`,
    "UNION ALL",
    "SELECT",
    `  ${columnNames.map((name) => `t.${name}`).join(",\n  ")},`,
    `  'synced' AS overlay_kind,`,
    `  ${syncedLocalUpdatedExpression} AS local_updated_at_us`,
    `FROM ${projection.syncedTable} AS t`,
    "WHERE NOT EXISTS (",
    "  SELECT 1",
    `  FROM ${projection.overlayTable} AS o`,
    `  WHERE ${pkMatch}`,
    ")",
  ].join("\n");
}

function buildTableColumnSql(columns: TableColumn[], primaryKeyColumns: string[]) {
  return [
    ...columns.map((column) => buildColumnDefinition(column, primaryKeyColumns)),
    ...buildCompositePrimaryKeyClauses(primaryKeyColumns),
  ].join(",\n  ");
}

function buildColumnDefinition(column: TableColumn, primaryKeyColumns: string[]) {
  const typeSql = mapColumnType(column);
  const notNullSql = column.notNull ? " NOT NULL" : "";
  const primaryKeySql = primaryKeyColumns.length === 1 && primaryKeyColumns.includes(column.name) ? " PRIMARY KEY" : "";
  return `${column.name} ${typeSql}${notNullSql}${primaryKeySql}`;
}

function buildCompositePrimaryKeyClauses(primaryKeyColumns: string[]) {
  if (primaryKeyColumns.length <= 1) {
    return [];
  }

  return [`PRIMARY KEY (${primaryKeyColumns.join(", ")})`];
}

function mapColumnType(column: TableColumn) {
  const baseTypeSql = readBaseColumnTypeSql(column);
  const dimensions = readArrayDimensions(column);

  if (dimensions > 0) {
    return `${baseTypeSql}${"[]".repeat(dimensions)}`;
  }

  return baseTypeSql;
}

function readBaseColumnTypeSql(column: TableColumn) {
  const sqlType = readColumnSqlType(column);

  if (sqlType) {
    return sqlType;
  }

  switch (column.columnType) {
    case "PgUUID":
      return "UUID";
    case "PgText":
      return "TEXT";
    case "PgVarchar":
      return `VARCHAR(${readVarcharLength(column) ?? 255})`;
    case "PgBigInt64":
    case "PgBigInt53":
      return "BIGINT";
    case "PgInteger":
    case "PgSerial":
    case "PgSmallInt":
      return "INTEGER";
    case "PgBoolean":
      return "BOOLEAN";
    case "PgJson":
    case "PgJsonb":
      return "JSONB";
    case "PgReal":
    case "PgDoublePrecision":
      return "REAL";
    case "PgTimestamp":
    case "PgTimestampString":
      return "TIMESTAMP";
    default:
      if (column.dataType.includes("uuid")) {
        return "UUID";
      }

      if (column.dataType.includes("bigint")) {
        return "BIGINT";
      }

      if (column.dataType.includes("json")) {
        return "JSONB";
      }

      if (column.dataType.includes("float")) {
        return "REAL";
      }

      if (column.dataType === "string") {
        return "TEXT";
      }

      throw new Error(`Unsupported column type for local schema generation: ${column.columnType}`);
  }
}

function readColumnSqlType(column: TableColumn) {
  const candidate = column as TableColumn & {
    getSQLType?: () => string;
  };

  return typeof candidate.getSQLType === "function" ? candidate.getSQLType() : undefined;
}

function readArrayDimensions(column: TableColumn) {
  const arrayColumn = column as TableColumn & { dimensions?: number };
  return arrayColumn.dimensions ?? 0;
}

function readVarcharLength(column: TableColumn) {
  const varcharColumn = column as { config?: { length?: number } };
  return varcharColumn.config?.length;
}

function buildPrimaryKeyMatch(primaryKeyColumns: string[]) {
  return primaryKeyColumns.map((column) => `o.${column} = t.${column}`).join(" AND ");
}

function getClientProjection(entry: SyncTableEntry, tableKey: string, localSchema: string): ClientProjectionSpec {
  const projection = baseProjection(entry, tableKey);

  return {
    syncedTable: qualifyIdentifier(localSchema, projection.syncedTable),
    ...(projection.overlayTable ? { overlayTable: qualifyIdentifier(localSchema, projection.overlayTable) } : {}),
    ...(projection.journalTable ? { journalTable: qualifyIdentifier(localSchema, projection.journalTable) } : {}),
    readModel: qualifyIdentifier(localSchema, projection.readModel),
  };
}

function baseProjection(entry: SyncTableEntry, tableKey: string) {
  if (!entry.clientProjection) {
    throw new Error(`clientProjection is required for local client table ${tableKey}`);
  }

  return entry.clientProjection;
}

function qualifyIdentifier(schemaName: string, objectName: string) {
  if (schemaName === "public") {
    return objectName;
  }

  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)}`;
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteSqlStringLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildJournalSequenceName(journalTable: string) {
  return `${journalTable}_mutation_seq`;
}
