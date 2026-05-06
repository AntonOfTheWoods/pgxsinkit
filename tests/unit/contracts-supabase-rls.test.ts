import { pgRole } from "drizzle-orm/pg-core";

import {
  buildSupabaseOwnerOrAdminGovernancePolicies,
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

  it("builds governance policies with default and custom role wiring", () => {
    const defaultPolicies = buildSupabaseOwnerOrAdminGovernancePolicies({
      tableName: "projects",
      ownerField: "ownerId",
    });

    expect(defaultPolicies.map((policy) => policy.name)).toEqual([
      "projects_select_owner_or_admin",
      "projects_insert_owner_or_admin",
      "projects_update_owner_or_admin",
      "projects_delete_owner_or_admin",
    ]);

    expect(defaultPolicies.map((policy) => policy.roles)).toEqual([
      ["authenticated"],
      ["authenticated"],
      ["authenticated"],
      ["authenticated"],
    ]);

    const customPolicies = buildSupabaseOwnerOrAdminGovernancePolicies({
      tableName: "projects",
      ownerField: "tenantId",
      ownerSqlColumn: "tenant_id",
      authenticatedRoleName: "member",
      adminRoleName: "maintainer",
      subjectCastType: "text",
    });

    expect(customPolicies.map((policy) => policy.roles)).toEqual([["member"], ["member"], ["member"], ["member"]]);

    expect(normalizeSqlText(customPolicies[0]?.using ?? "")).toContain("tenant_id = coalesce(");
    expect(normalizeSqlText(customPolicies[0]?.using ?? "")).toContain("::text");
    expect(normalizeSqlText(customPolicies[0]?.using ?? "")).toContain("assigned_role.role_name_value = 'maintainer'");

    expect(customPolicies[0]?.usingColumns).toEqual(["tenantId"]);
    expect(customPolicies[1]?.withCheckColumns).toEqual(["tenantId"]);
    expect(customPolicies[2]?.usingColumns).toEqual(["tenantId"]);
    expect(customPolicies[2]?.withCheckColumns).toEqual(["tenantId"]);
    expect(customPolicies[3]?.usingColumns).toEqual(["tenantId"]);
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
});
