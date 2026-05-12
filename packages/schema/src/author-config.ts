import type { TableSpec, TableSpecInput } from "@pgxsinkit/contracts";

import {
  createAuthorInputSchema,
  updateAuthorInputSchema,
  type CreateAuthorInput,
  type UpdateAuthorInput,
} from "./authors";

export const authorTableSpecInput = {
  name: "authors",
  mode: "readwrite",
  primaryKey: {
    columns: ["id"],
  },
  shape: {
    tableName: "authors",
    shapeKey: "authors",
  },
  clientProjection: {
    syncedTable: "authors",
    overlayTable: "author_overlay",
    journalTable: "author_mutations",
  },
} satisfies TableSpecInput;

export const authorTableSpec = {
  ...authorTableSpecInput,
  schemas: {
    createSchema: createAuthorInputSchema,
    updateSchema: updateAuthorInputSchema,
  },
  adapters: {
    toEntityKey: (record) => ({
      id: String(record.id),
    }),
  },
} satisfies TableSpec<CreateAuthorInput, UpdateAuthorInput>;
