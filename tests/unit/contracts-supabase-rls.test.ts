import { describe, expect, it } from "bun:test";

import type { SQL } from "drizzle-orm";
import { boolean, PgDialect, pgRole, pgTable, uuid, varchar, type AnyPgTable } from "drizzle-orm/pg-core";

import {
  buildSupabaseMembershipNativePolicies,
  buildSupabaseOwnerOrAdminNativePolicies,
  buildSupabaseOwnerOrAdminPredicateSqlText,
  supabaseOwnerOrAdminDefaults,
} from "@pgxsinkit/contracts";

type NativeSqlChunk = {
  value?: string[];
};

type NativeSqlExpression = {
  queryChunks: NativeSqlChunk[];
};

type NativePolicy = {
  name: string;
  as: string;
  for: string;
  to: string | { name: string } | Array<string | { name: string }>;
  using?: NativeSqlExpression;
  withCheck?: NativeSqlExpression;
};

function normalizeSqlText(sqlText: string): string {
  return sqlText.replace(/\s+/g, " ").trim();
}

function nativeSqlToText(value: NativeSqlExpression | undefined): string | null {
  if (!value) {
    return null;
  }

  return normalizeSqlText(
    value.queryChunks
      .map((chunk) => ("value" in chunk && Array.isArray(chunk.value) ? chunk.value.join("") : ""))
      .join(""),
  );
}

// Render a composed Drizzle SQL fragment (operators + columns + nested sql) to its real DDL text.
// The hand-rolled nativeSqlToText only joins `sql.raw` string chunks; a fragment built from columns
// needs the dialect to qualify and serialize it.
const dialect = new PgDialect();
function renderSql(fragment: unknown): string | null {
  if (!fragment) {
    return null;
  }
  return normalizeSqlText(dialect.sqlToQuery(fragment as SQL).sql);
}

// Drizzle stashes the `extras` callback's result (our pgPolicy array) on the built table under an
// ExtraConfigBuilder symbol; invoke it with the table to recover the policies.
function readTablePolicies(table: AnyPgTable): NativePolicy[] {
  const symbol = Object.getOwnPropertySymbols(table).find((s) => s.description?.includes("ExtraConfigBuilder"));
  const builder = symbol ? (table as unknown as Record<symbol, (t: AnyPgTable) => unknown>)[symbol] : undefined;
  const extras = typeof builder === "function" ? builder(table) : undefined;
  const list = Array.isArray(extras) ? extras : Object.values(extras ?? {});
  return list.filter(
    (entry): entry is NativePolicy => typeof entry === "object" && entry !== null && "for" in entry && "name" in entry,
  );
}

function nativeRoleToName(role: NativePolicy["to"]): string {
  const normalized = Array.isArray(role) ? role[0] : role;
  if (!normalized) {
    return "";
  }

  if (typeof normalized === "string") {
    return normalized;
  }

  if (typeof normalized === "object" && "name" in normalized && typeof normalized.name === "string") {
    return normalized.name;
  }

  return "";
}

describe("contracts supabase RLS helpers", () => {
  it("exposes stable defaults and builds default predicate SQL", () => {
    expect(supabaseOwnerOrAdminDefaults).toEqual({
      ownerSqlColumn: "owner_id",
      ownerPropertyKey: "ownerId",
      authenticatedRoleName: "authenticated",
      adminRoleName: "admin",
      subjectCastType: "uuid",
    });

    const predicate = normalizeSqlText(buildSupabaseOwnerOrAdminPredicateSqlText());

    expect(predicate).toContain("owner_id = coalesce(");
    expect(predicate).toContain("::uuid");
    expect(predicate).toContain("jsonb_array_elements_text(");
    expect(predicate).toContain("assigned_role.role_name_value = 'admin'");
    expect(predicate).toContain("current_setting('request.jwt.claim.sub', true)");
    expect(predicate).toContain("current_setting('request.jwt.claims', true)");
  });

  it("supports custom Supabase-compatible claim and role options", () => {
    const predicate = normalizeSqlText(
      buildSupabaseOwnerOrAdminPredicateSqlText({
        ownerSqlColumn: "tenant_owner_id",
        adminRoleName: "team'lead",
        subjectCastType: "text",
      }),
    );

    expect(predicate).toContain("tenant_owner_id = coalesce(");
    expect(predicate).toContain("::text");
    expect(predicate).toContain("assigned_role.role_name_value = 'team''lead'");
  });

  it("builds native Drizzle policies that keep command semantics and predicate parity", () => {
    const role = pgRole("member");
    const predicate = normalizeSqlText(
      buildSupabaseOwnerOrAdminPredicateSqlText({
        ownerSqlColumn: "tenant_id",
        adminRoleName: "maintainer",
      }),
    );

    const policies = buildSupabaseOwnerOrAdminNativePolicies({
      tableName: "projects",
      role,
      ownerSqlColumn: "tenant_id",
      adminRoleName: "maintainer",
    }) as NativePolicy[];

    const byCommand = Object.fromEntries(
      policies.map((policy) => [
        policy.for,
        {
          name: policy.name,
          mode: policy.as,
          role: nativeRoleToName(policy.to),
          using: nativeSqlToText(policy.using),
          withCheck: nativeSqlToText(policy.withCheck),
        },
      ]),
    );

    expect(byCommand).toEqual({
      select: {
        name: "projects_select_owner_or_admin",
        mode: "permissive",
        role: "member",
        using: predicate,
        withCheck: null,
      },
      insert: {
        name: "projects_insert_owner_or_admin",
        mode: "permissive",
        role: "member",
        using: null,
        withCheck: predicate,
      },
      update: {
        name: "projects_update_owner_or_admin",
        mode: "permissive",
        role: "member",
        using: predicate,
        withCheck: predicate,
      },
      delete: {
        name: "projects_delete_owner_or_admin",
        mode: "permissive",
        role: "member",
        using: predicate,
        withCheck: null,
      },
    });
  });

  it("gates membership INSERT/UPDATE on write-state but leaves SELECT/DELETE open", () => {
    // The builder takes real Drizzle columns/tables now, so we build a fixture schema and pass its
    // columns. The governed table name (for policy identifiers) is derived from the container column,
    // and predicates serialize with qualified columns + inlined literals (valid CREATE POLICY DDL).
    const role = pgRole("authenticated");

    const workspaces = pgTable("workspaces", {
      id: uuid("id").primaryKey(),
      locked: boolean("locked").notNull().default(false),
    });
    const workspaceMembers = pgTable("workspace_members", {
      id: uuid("id").primaryKey(),
      workspaceId: uuid("workspace_id").notNull(),
      memberId: uuid("member_id").notNull(),
      role: varchar("role", { length: 32 }).notNull(),
      muted: boolean("muted").notNull().default(false),
    });
    const workItems = pgTable(
      "work_items",
      {
        id: uuid("id").primaryKey(),
        workspaceId: uuid("workspace_id").notNull(),
        ownerId: uuid("owner_id"),
      },
      (t) =>
        buildSupabaseMembershipNativePolicies({
          role,
          containerColumn: t.workspaceId,
          ownerColumn: t.ownerId,
          membershipTable: workspaceMembers,
          membershipContainerColumn: workspaceMembers.workspaceId,
          membershipSubjectColumn: workspaceMembers.memberId,
          managerRoleColumn: workspaceMembers.role,
          writeGate: {
            containerTable: workspaces,
            containerPkColumn: workspaces.id,
            containerLockColumn: workspaces.locked,
            membershipMutedColumn: workspaceMembers.muted,
          },
        }),
    );

    const policies = readTablePolicies(workItems);

    const byCommand = Object.fromEntries(
      policies.map((policy) => [
        policy.for,
        {
          name: policy.name,
          using: renderSql(policy.using),
          withCheck: renderSql(policy.withCheck),
        },
      ]),
    );

    // Governed table name is derived from the container column's table.
    expect(byCommand["select"]?.name).toBe("work_items_select_membership");

    // Columns serialize qualified (write path = Postgres RLS, unlike Electric's bare-column rule).
    expect(byCommand["insert"]?.withCheck).toContain('"work_items"."owner_id" =');
    expect(byCommand["insert"]?.withCheck).toContain('from "workspaces" where "workspaces"."locked" = false');
    expect(byCommand["insert"]?.withCheck).toContain('"workspace_members"."muted" = false');
    // Manager literal inlined, not a bound param.
    expect(byCommand["insert"]?.withCheck).toContain(`"workspace_members"."role" = 'manager'`);
    expect(byCommand["insert"]?.withCheck).not.toMatch(/\$\d/);

    // UPDATE gates both USING and WITH CHECK.
    expect(byCommand["update"]?.using).toContain('from "workspaces" where "workspaces"."locked" = false');
    expect(byCommand["update"]?.withCheck).toContain('"workspace_members"."muted" = false');

    // SELECT and DELETE are untouched by write-state.
    expect(byCommand["select"]?.using).not.toContain("locked");
    expect(byCommand["select"]?.using).not.toContain("muted");
    expect(byCommand["delete"]?.using).not.toContain("locked");
    expect(byCommand["delete"]?.using).not.toContain("muted");
  });
});
