import { describe, expect, it } from "bun:test";

import { pgRole } from "drizzle-orm/pg-core";

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
    const policies = buildSupabaseMembershipNativePolicies({
      tableName: "work_items",
      role: pgRole("authenticated"),
      containerSqlColumn: "workspace_id",
      membershipTableName: "workspace_members",
      membershipContainerSqlColumn: "workspace_id",
      membershipSubjectSqlColumn: "member_id",
      managerRoleSqlColumn: "role",
      writeGate: {
        containerTableName: "workspaces",
        containerPkSqlColumn: "id",
        containerLockSqlColumn: "locked",
        membershipMutedSqlColumn: "muted",
      },
    }) as NativePolicy[];

    const byCommand = Object.fromEntries(
      policies.map((policy) => [
        policy.for,
        { using: nativeSqlToText(policy.using), withCheck: nativeSqlToText(policy.withCheck) },
      ]),
    );

    // INSERT WITH CHECK keeps owner+member and adds the write-state gate (lock bypassable by a manager,
    // plus a not-muted requirement).
    expect(byCommand["insert"]?.withCheck).toContain("owner_id =");
    expect(byCommand["insert"]?.withCheck).toContain("FROM workspaces WHERE locked = false");
    expect(byCommand["insert"]?.withCheck).toContain("AND muted = false");

    // UPDATE gates both USING and WITH CHECK.
    expect(byCommand["update"]?.using).toContain("FROM workspaces WHERE locked = false");
    expect(byCommand["update"]?.withCheck).toContain("AND muted = false");

    // SELECT and DELETE are untouched by write-state.
    expect(byCommand["select"]?.using).not.toContain("locked");
    expect(byCommand["select"]?.using).not.toContain("muted");
    expect(byCommand["delete"]?.using).not.toContain("locked");
    expect(byCommand["delete"]?.using).not.toContain("muted");
  });
});
