import type { TableSpec, TableSpecInput } from "@pgxsinkit/contracts";

import { createTodoInputSchema, updateTodoInputSchema, type CreateTodoInput, type UpdateTodoInput } from "./todos";

export const todoTableSpecInput = {
  name: "todos",
  mode: "readwrite",
  primaryKey: {
    columns: ["id"],
  },
  shape: {
    tableName: "todos",
    shapeKey: "todos",
  },
  clientProjection: {
    syncedTable: "todos",
    overlayTable: "todo_overlay",
    journalTable: "todo_mutations",
  },
} satisfies TableSpecInput;

export const todoTableSpec = {
  ...todoTableSpecInput,
  schemas: {
    createSchema: createTodoInputSchema,
    updateSchema: updateTodoInputSchema,
  },
  adapters: {
    toEntityKey: (record) => ({
      id: String(record.id),
    }),
  },
} satisfies TableSpec<CreateTodoInput, UpdateTodoInput>;
