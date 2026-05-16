import { sql } from "drizzle-orm";
import { bigint, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import {
  buildSupabaseOwnerOrAdminNativePolicies,
  defineSyncRegistry,
  defineSyncTable,
  type TableSpecInput,
} from "@pgxsinkit/contracts";

const nowMicrosecondsSql = sql`CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)`;

const makeProjectsColumns = () => ({
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
});

const projectsSyncEntry = defineSyncTable({
  tableName: "projects",
  makeColumns: makeProjectsColumns,
  mode: "readwrite",
});

export const projectsTable = projectsSyncEntry.table;
export const projectsView = projectsSyncEntry.view;

export type CreateProjectInput = typeof projectsTable.$inferInsert;

export const projectTableSpecInput = {
  mode: "readwrite",
  primaryKey: {
    columns: ["id"],
  },
  shape: {
    tableName: "projects",
    shapeKey: "projects",
  },
} satisfies TableSpecInput;

export const projectTableSpec = projectTableSpecInput;

export const projectsSyncRegistry = defineSyncRegistry({
  projects: projectsSyncEntry,
});

const fkParentsSyncEntry = defineSyncTable({
  tableName: "fk_parents",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
  }),
  mode: "readwrite",
});

export const fkParentsTable = fkParentsSyncEntry.table;

const fkChildrenSyncEntry = defineSyncTable({
  tableName: "fk_children",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => fkParentsTable.id, { name: "fk_children_parent_fk" }),
  }),
  mode: "readwrite",
  governance: {
    deferrableConstraints: [
      {
        constraintName: "fk_children_parent_fk",
        columns: ["parentId"],
        initiallyDeferred: false,
      },
    ],
  },
});

export const fkChildrenTable = fkChildrenSyncEntry.table;

export const fkSyncRegistry = defineSyncRegistry({
  fk_parents: fkParentsSyncEntry,
  fk_children: fkChildrenSyncEntry,
});

const rlsTodosSyncEntry = defineSyncTable({
  tableName: "rls_todos",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 120 }).notNull(),
    ownerId: uuid("owner_id").default(sql`auth.uid()`),
  }),
  policies: buildSupabaseOwnerOrAdminNativePolicies({
    tableName: "rls_todos",
    role: authenticatedRole,
    ownerSqlColumn: "owner_id",
  }),
  mode: "readwrite",
});

export const rlsTodosTable = rlsTodosSyncEntry.table;

export const rlsSyncRegistry = defineSyncRegistry({
  rls_todos: rlsTodosSyncEntry,
});
