import { sql } from "drizzle-orm";
import { bigint, text, uuid, varchar } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { buildSupabaseOwnerOrAdminNativePolicies, defineSyncTable } from "@pgxsinkit/contracts";

import { authorTableSpec } from "./author-config";
import { todoTableSpec } from "./todo-config";

const nowMicrosecondsSql = sql`(floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric)))`;

const makeAuthorsColumns = () => ({
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  ownerId: uuid("owner_id"),
  modifiedBy: uuid("modified_by"),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
});

const authorsSyncEntry = defineSyncTable({
  tableName: "authors",
  makeColumns: makeAuthorsColumns,
  policies: buildSupabaseOwnerOrAdminNativePolicies({
    tableName: "authors",
    role: authenticatedRole,
  }),
  mode: "readwrite",
  shape: authorTableSpec.shape,
  clientProjection: authorTableSpec.clientProjection,
  governance: {
    managedFields: [
      { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
      { column: "modifiedBy", applyOn: ["create", "update"], strategy: "authUid" },
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
  schemas: authorTableSpec.schemas,
  adapters: authorTableSpec.adapters,
});

const makeTodosColumns = () => ({
  id: uuid("id").primaryKey(),
  title: varchar("title", { length: 120 }).notNull(),
  description: text("description"),
  authorId: uuid("author_id")
    .notNull()
    .references(() => authorsSyncEntry.table.id),
  ownerId: uuid("owner_id"),
  modifiedBy: uuid("modified_by"),
  status: varchar("status", { length: 24 }).notNull().default("todo"),
  priority: varchar("priority", { length: 24 }).notNull().default("medium"),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
});

const todosSyncEntry = defineSyncTable({
  tableName: "todos",
  makeColumns: makeTodosColumns,
  policies: buildSupabaseOwnerOrAdminNativePolicies({
    tableName: "todos",
    role: authenticatedRole,
  }),
  mode: "readwrite",
  shape: todoTableSpec.shape,
  clientProjection: todoTableSpec.clientProjection,
  governance: {
    deferrableConstraints: [
      {
        constraintName: "todos_author_id_authors_id_fkey",
        columns: ["authorId"],
        initiallyDeferred: false,
      },
    ],
    managedFields: [
      { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
      { column: "modifiedBy", applyOn: ["create", "update"], strategy: "authUid" },
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
  schemas: todoTableSpec.schemas,
  adapters: todoTableSpec.adapters,
});

export const authorsTable = authorsSyncEntry.table;
export const authorsView = authorsSyncEntry.view!;
export const todosTable = todosSyncEntry.table;
export const todosView = todosSyncEntry.view!;
export { authorsSyncEntry, todosSyncEntry };

export type AuthorRow = typeof authorsTable.$inferSelect;
export type NewAuthorRow = typeof authorsTable.$inferInsert;
export type AuthorRecord = typeof authorsTable.$inferSelect;
export type TodoRow = typeof todosTable.$inferSelect;
export type NewTodoRow = typeof todosTable.$inferInsert;
export type TodoRecord = typeof todosTable.$inferSelect;
