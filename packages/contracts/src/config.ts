import { z } from "zod";

export const tableModeSchema = z.enum(["readonly", "writeonly", "readwrite"]);

export const primaryKeySpecSchema = z
  .object({
    columns: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export const shapeSpecSchema = z
  .object({
    tableName: z.string().trim().min(1),
    shapeKey: z.string().trim().min(1),
    electricTable: z.string().trim().min(1).optional(),
  })
  .strict();

export const serverRouteSpecSchema = z
  .object({
    basePath: z.string().trim().min(1),
    allowBatch: z.boolean().default(false),
  })
  .strict();

export const clientProjectionSpecSchema = z
  .object({
    syncedTable: z.string().trim().min(1),
    overlayTable: z.string().trim().min(1).optional(),
    journalTable: z.string().trim().min(1).optional(),
    readModel: z.string().trim().min(1),
    omitColumns: z.array(z.string().trim().min(1)).optional(),
    localPrimaryKey: primaryKeySpecSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.omitColumns && new Set(value.omitColumns).size !== value.omitColumns.length) {
      context.addIssue({
        code: "custom",
        message: "omitColumns must not contain duplicate entries",
        path: ["omitColumns"],
      });
    }

    if (value.localPrimaryKey && new Set(value.localPrimaryKey.columns).size !== value.localPrimaryKey.columns.length) {
      context.addIssue({
        code: "custom",
        message: "localPrimaryKey.columns must not contain duplicate entries",
        path: ["localPrimaryKey", "columns"],
      });
    }
  });

export const deferrableConstraintSpecSchema = z
  .object({
    constraintName: z.string().trim().min(1),
    columns: z.array(z.string().trim().min(1)).min(1),
    initiallyDeferred: z.boolean().optional(),
  })
  .strict();

export const rlsPolicyCommandSchema = z.enum(["all", "select", "insert", "update", "delete"]);
export const rlsPolicyModeSchema = z.enum(["permissive", "restrictive"]);

export const rlsPolicySpecSchema = z
  .object({
    name: z.string().trim().min(1),
    command: rlsPolicyCommandSchema,
    as: rlsPolicyModeSchema.default("permissive"),
    roles: z.array(z.string().trim().min(1)).min(1),
    using: z.string().trim().min(1).optional(),
    withCheck: z.string().trim().min(1).optional(),
    usingColumns: z.array(z.string().trim().min(1)).optional(),
    withCheckColumns: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.command === "select" || value.command === "delete") && value.using === undefined) {
      context.addIssue({
        code: "custom",
        message: "using is required for SELECT and DELETE policies",
        path: ["using"],
      });
    }

    if (value.command === "insert" && value.withCheck === undefined) {
      context.addIssue({
        code: "custom",
        message: "withCheck is required for INSERT policies",
        path: ["withCheck"],
      });
    }

    if (value.command === "update" && value.using === undefined && value.withCheck === undefined) {
      context.addIssue({
        code: "custom",
        message: "update policies must declare at least one of using or withCheck",
      });
    }
  });

export const rowLevelSecuritySpecSchema = z
  .object({
    enabled: z.boolean().default(false),
    force: z.boolean().default(false),
    policies: z.array(rlsPolicySpecSchema).default([]),
  })
  .strict();

export const managedFieldApplyOnSchema = z.enum(["create", "update"]);
export const managedFieldStrategySchema = z.enum(["authUid", "nowMicroseconds"]);

export const managedFieldSpecSchema = z
  .object({
    column: z.string().trim().min(1),
    applyOn: z.array(managedFieldApplyOnSchema).min(1),
    strategy: managedFieldStrategySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.applyOn).size !== value.applyOn.length) {
      context.addIssue({
        code: "custom",
        message: "applyOn must not contain duplicate operations",
        path: ["applyOn"],
      });
    }
  });

export const tableGovernanceSpecSchema = z
  .object({
    deferrableConstraints: z.array(deferrableConstraintSpecSchema).optional(),
    managedFields: z.array(managedFieldSpecSchema).optional(),
    rls: rowLevelSecuritySpecSchema.optional(),
  })
  .strict();

export const tableSpecInputSchema = z
  .object({
    name: z.string().trim().min(1),
    mode: tableModeSchema,
    primaryKey: primaryKeySpecSchema,
    shape: shapeSpecSchema.optional(),
    clientProjection: clientProjectionSpecSchema.optional(),
    governance: tableGovernanceSpecSchema.optional(),
    routes: serverRouteSpecSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode !== "writeonly" && value.shape === undefined) {
      context.addIssue({
        code: "custom",
        message: "shape is required for readonly and readwrite tables",
        path: ["shape"],
      });
    }

    if (value.mode !== "writeonly" && value.clientProjection === undefined) {
      context.addIssue({
        code: "custom",
        message: "clientProjection is required for readonly and readwrite tables",
        path: ["clientProjection"],
      });
    }

    if (value.clientProjection?.localPrimaryKey && value.mode !== "readonly") {
      context.addIssue({
        code: "custom",
        message: "clientProjection.localPrimaryKey is only supported for readonly tables",
        path: ["clientProjection", "localPrimaryKey"],
      });
    }

    const omittedColumns = new Set(value.clientProjection?.omitColumns ?? []);
    const localPrimaryKeyColumns = value.clientProjection?.localPrimaryKey?.columns ?? [];
    const omittedLocalPrimaryKeyColumns = localPrimaryKeyColumns.filter((column) => omittedColumns.has(column));

    if (omittedLocalPrimaryKeyColumns.length > 0) {
      context.addIssue({
        code: "custom",
        message:
          "clientProjection.localPrimaryKey.columns must not include omitted columns: " +
          omittedLocalPrimaryKeyColumns.join(", "),
        path: ["clientProjection", "localPrimaryKey", "columns"],
      });
    }
  });

export const syncConfigSchema = z
  .object({
    electricUrl: z.url(),
    localSchema: z.string().trim().min(1).optional(),
    tables: z.record(z.string(), tableSpecInputSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.tables).length === 0) {
      context.addIssue({
        code: "custom",
        message: "at least one table must be configured",
        path: ["tables"],
      });
    }

    for (const [key, spec] of Object.entries(value.tables)) {
      if (spec.name !== key) {
        context.addIssue({
          code: "custom",
          message: "table config key must match spec.name",
          path: ["tables", key, "name"],
        });
      }
    }
  });

export type TableMode = z.infer<typeof tableModeSchema>;
export type PrimaryKeySpec = z.infer<typeof primaryKeySpecSchema>;
export type ShapeSpec = z.infer<typeof shapeSpecSchema>;
export type ServerRouteSpec = z.infer<typeof serverRouteSpecSchema>;
export type ClientProjectionSpec = z.infer<typeof clientProjectionSpecSchema>;
export type DeferrableConstraintSpec = z.infer<typeof deferrableConstraintSpecSchema>;
export type RlsPolicyCommand = z.infer<typeof rlsPolicyCommandSchema>;
export type RlsPolicyMode = z.infer<typeof rlsPolicyModeSchema>;
export type RlsPolicySpec = z.infer<typeof rlsPolicySpecSchema>;
export type RowLevelSecuritySpec = z.infer<typeof rowLevelSecuritySpecSchema>;
export type ManagedFieldApplyOn = z.infer<typeof managedFieldApplyOnSchema>;
export type ManagedFieldStrategy = z.infer<typeof managedFieldStrategySchema>;
export type ManagedFieldSpec = z.infer<typeof managedFieldSpecSchema>;
export type TableGovernanceSpec = z.infer<typeof tableGovernanceSpecSchema>;
export type TableSpecInput = z.infer<typeof tableSpecInputSchema>;
export type SyncConfigInput = z.infer<typeof syncConfigSchema>;

export interface TableSchemas<TCreate, TUpdate, TRecord> {
  createSchema: z.ZodType<TCreate>;
  updateSchema: z.ZodType<TUpdate>;
  recordSchema: z.ZodType<TRecord>;
}

export interface TableAdapters {
  toEntityKey?: (record: Record<string, unknown>) => Record<string, string>;
}

export interface TableSpec<TCreate, TUpdate, TRecord> extends TableSpecInput {
  schemas: TableSchemas<TCreate, TUpdate, TRecord>;
  adapters?: TableAdapters;
}

export interface SyncConfig {
  electricUrl: string;
  tables: Record<string, TableSpec<any, any, any>>;
}

export function getLocalSyncPrimaryKey(source: {
  primaryKey: PrimaryKeySpec;
  clientProjection?: Pick<ClientProjectionSpec, "localPrimaryKey">;
}) {
  return source.clientProjection?.localPrimaryKey ?? source.primaryKey;
}

export function getLocalSyncPrimaryKeyColumns(source: {
  primaryKey: PrimaryKeySpec;
  clientProjection?: Pick<ClientProjectionSpec, "localPrimaryKey">;
}) {
  return [...getLocalSyncPrimaryKey(source).columns];
}
