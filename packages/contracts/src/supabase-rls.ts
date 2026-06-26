import { and, eq, getTableName, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { pgPolicy, type AnyPgTable, type PgRole } from "drizzle-orm/pg-core";

import { escapeSqlLiteral, quoteSqlLiteral } from "./sql-identifier";

type SupabaseOwnerOrAdminPolicyKind = "select" | "insert" | "update" | "delete";

type SupabaseOwnerOrAdminPolicyShape = {
  command: SupabaseOwnerOrAdminPolicyKind;
  using: boolean;
  withCheck: boolean;
};

export type SupabaseOwnerOrAdminPredicateOptions = {
  ownerSqlColumn?: string;
  adminRoleName?: string;
  subjectCastType?: string;
};

export type SupabaseOwnerOrAdminNativePoliciesOptions = SupabaseOwnerOrAdminPredicateOptions & {
  tableName: string;
  role: PgRole;
};

const defaultOwnerSqlColumn = "owner_id";
const defaultOwnerPropertyKey = "ownerId";
const defaultAuthenticatedRoleName = "authenticated";
const defaultAdminRoleName = "admin";
const defaultSubjectCastType = "uuid";

const ownerOrAdminPolicyShapes: SupabaseOwnerOrAdminPolicyShape[] = [
  {
    command: "select",
    using: true,
    withCheck: false,
  },
  {
    command: "insert",
    using: false,
    withCheck: true,
  },
  {
    command: "update",
    using: true,
    withCheck: true,
  },
  {
    command: "delete",
    using: true,
    withCheck: false,
  },
];

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be a valid SQL identifier: ${value}`);
  }
}

function assertTypeName(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) {
    throw new Error(`${label} must be a valid SQL type name: ${value}`);
  }
}

function buildOwnerOrAdminPolicyName(tableName: string, command: SupabaseOwnerOrAdminPolicyKind) {
  return `${tableName}_${command}_owner_or_admin`;
}

function normalizePredicateOptions(options: SupabaseOwnerOrAdminPredicateOptions = {}) {
  const ownerSqlColumn = options.ownerSqlColumn ?? defaultOwnerSqlColumn;
  const adminRoleName = options.adminRoleName ?? defaultAdminRoleName;
  const subjectCastType = options.subjectCastType ?? defaultSubjectCastType;

  assertIdentifier(ownerSqlColumn, "ownerSqlColumn");
  assertTypeName(subjectCastType, "subjectCastType");

  return {
    ownerSqlColumn,
    adminRoleName,
    subjectCastType,
  };
}

function toPredicateOptions(options: SupabaseOwnerOrAdminPredicateOptions): SupabaseOwnerOrAdminPredicateOptions {
  return {
    ...(options.ownerSqlColumn !== undefined ? { ownerSqlColumn: options.ownerSqlColumn } : {}),
    ...(options.adminRoleName !== undefined ? { adminRoleName: options.adminRoleName } : {}),
    ...(options.subjectCastType !== undefined ? { subjectCastType: options.subjectCastType } : {}),
  };
}

export function buildSupabaseOwnerOrAdminPredicateSqlText(options: SupabaseOwnerOrAdminPredicateOptions = {}): string {
  const normalized = normalizePredicateOptions(options);

  return `
  ${normalized.ownerSqlColumn} = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::${normalized.subjectCastType}
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = '${escapeSqlLiteral(normalized.adminRoleName)}'
  )
`;
}

export function buildSupabaseOwnerOrAdminNativePolicies(options: SupabaseOwnerOrAdminNativePoliciesOptions) {
  const predicate = sql.raw(buildSupabaseOwnerOrAdminPredicateSqlText(toPredicateOptions(options)));

  return ownerOrAdminPolicyShapes.map((shape) =>
    pgPolicy(buildOwnerOrAdminPolicyName(options.tableName, shape.command), {
      as: "permissive",
      for: shape.command,
      to: options.role,
      ...(shape.using ? { using: predicate } : {}),
      ...(shape.withCheck ? { withCheck: predicate } : {}),
    }),
  );
}

export const supabaseOwnerOrAdminDefaults = {
  ownerSqlColumn: defaultOwnerSqlColumn,
  ownerPropertyKey: defaultOwnerPropertyKey,
  authenticatedRoleName: defaultAuthenticatedRoleName,
  adminRoleName: defaultAdminRoleName,
  subjectCastType: defaultSubjectCastType,
} as const;

// ---------------------------------------------------------------------------
// Membership-scoped policies (generic). A row belongs to a *container* and is
// visible/writable through membership of that container — not just ownership.
// This is the readwrite counterpart to a membership row-filter: every member of
// the container may read the row (fan-out to non-owners); only the owner may
// create it (as themselves) and edit it, while a container *manager* may moderate
// any row. Domain-agnostic: the container, membership table, and manager role are
// all parameters.
//
// The container, membership, and owner references are **real Drizzle columns/tables**
// (not name strings), so the policy tracks the schema — a column or table rename is a
// compile error, and the governed table name is *derived* from the container column
// (no redundant `tableName` to drift). Predicate structure is built with Drizzle
// operators (`and`/`or`/`eq`); only the irreducibly-Postgres leaves stay `sql`: the
// `IN (subquery)` containment (Drizzle's `inArray` cannot wrap a raw subquery), the
// `current_setting(...)::type` JWT-subject expression, and the inlined `'manager'` /
// `false` literals (a value passed to `eq` would parameterize, which `CREATE POLICY`
// DDL cannot carry). Columns serialize qualified (`"work_items"."workspace_id"`) —
// fine for Postgres RLS (this is the write path, unlike Electric's bare-column rule).
// ---------------------------------------------------------------------------

type MembershipPolicyKind = "select" | "insert" | "update" | "delete";

export type SupabaseMembershipPredicateColumns = {
  /** Column on the governed row naming its container (e.g. `workItems.workspaceId`). */
  containerColumn: AnyColumn;
  /** Membership link table (e.g. the `workspace_members` table). */
  membershipTable: AnyPgTable;
  /** Container column on the membership link table (e.g. `workspaceMembers.workspaceId`). */
  membershipContainerColumn: AnyColumn;
  /** Subject (member) column on the membership link table, compared to the JWT sub. */
  membershipSubjectColumn: AnyColumn;
  /** Owner column on the governed row (e.g. `workItems.ownerId`). */
  ownerColumn: AnyColumn;
  /** Optional role column on the membership link enabling manager moderation. */
  managerRoleColumn?: AnyColumn;
  /** Role value that grants moderation (default "manager"); only used with managerRoleColumn. */
  managerRoleValue?: string;
  /** SQL type the JWT subject is cast to before comparison (default "uuid"). */
  subjectCastType?: string;
};

// Optional write-state gate (generic). When supplied, INSERT and UPDATE are additionally gated on
// mutable state: a *locked* container admits writes only from a manager (e.g. a frozen discussion
// thread), and a *muted* member may not write at all. SELECT and DELETE are unaffected — reads and
// moderation deletes still flow. Domain-agnostic: the container/lock and membership/mute columns are
// parameters. Requires managerRoleColumn (managers bypass the lock).
export type SupabaseMembershipWriteGateColumns = {
  /** Container table holding the lock flag (e.g. the `workspaces` table). */
  containerTable: AnyPgTable;
  /** PK column on the container table the governed row's container column references (e.g. `workspaces.id`). */
  containerPkColumn: AnyColumn;
  /** Boolean column on the container table; when true, only a manager may write (e.g. `workspaces.locked`). */
  containerLockColumn: AnyColumn;
  /** Boolean column on the membership table; when true, that member may not write (e.g. `workspaceMembers.muted`). */
  membershipMutedColumn: AnyColumn;
};

export type SupabaseMembershipNativePoliciesOptions = SupabaseMembershipPredicateColumns & {
  role: PgRole;
  /** Optional write-state gate applied to INSERT and UPDATE only. */
  writeGate?: SupabaseMembershipWriteGateColumns;
};

const defaultManagerRoleValue = "manager";

const membershipPolicyShapes: { command: MembershipPolicyKind; using: boolean; withCheck: boolean }[] = [
  { command: "select", using: true, withCheck: false },
  { command: "insert", using: false, withCheck: true },
  { command: "update", using: true, withCheck: true },
  { command: "delete", using: true, withCheck: false },
];

// The JWT subject as a Postgres expression (irreducibly raw: `current_setting` + cast). Used as the
// right-hand side of `eq(memberColumn, subject)` — eq splices an SQL fragment verbatim (no bound
// param), so the DDL carries the literal expression, not a `$n` CREATE POLICY cannot bind.
function buildSubjectSql(subjectCastType: string): SQL {
  assertTypeName(subjectCastType, "subjectCastType");
  return sql.raw(`coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::${subjectCastType}`);
}

// A bare SQL literal (`false`, `'manager'`) for an `eq` right-hand side. `eq(col, value)` would
// parameterize `value` to `$n`; `eq(col, sql\`…\`)` inlines it — required for CREATE POLICY DDL.
const FALSE_LITERAL = sql`false`;
function textLiteral(value: string): SQL {
  return sql.raw(quoteSqlLiteral(value));
}

type NormalizedMembershipColumns = SupabaseMembershipPredicateColumns & {
  managerRoleValue: string;
  subjectCastType: string;
};

function normalizeMembershipColumns(options: SupabaseMembershipPredicateColumns): NormalizedMembershipColumns {
  return {
    ...options,
    managerRoleValue: options.managerRoleValue ?? defaultManagerRoleValue,
    subjectCastType: options.subjectCastType ?? defaultSubjectCastType,
  };
}

// The governed table name (for policy identifiers) is derived from the container column's table, so
// renaming the table renames its policies too — no separate string to drift. Columns built inside
// `defineSyncTable`'s `extras` callback carry their `.table`, which is where these builders are meant
// to be called (the table object does not yet exist when its own `policies:` array would be built).
function governedTableName(containerColumn: AnyColumn): string {
  const table = (containerColumn as { table?: AnyPgTable }).table;
  if (!table) {
    throw new Error(
      "containerColumn must be a built Drizzle column carrying its table — call buildSupabaseMembershipNativePolicies inside defineSyncTable's `extras` callback",
    );
  }
  return getTableName(table);
}

// Containment form (not a correlated EXISTS): the governed row's container column must be IN the
// set of containers the subject belongs to. The IN keeps the outer container reference in the
// policy table's scope — a correlated `EXISTS (… WHERE m.container = container …)` would let the
// membership table's same-named column shadow the outer one, collapsing the correlation. `inArray`
// can't wrap a raw subquery, so the `IN (…)` stays `sql`; its leaves are Drizzle `eq`/`and`.
function membershipMatch(cols: NormalizedMembershipColumns, subject: SQL, requireManager: boolean): SQL {
  const subjectIsMember = eq(cols.membershipSubjectColumn, subject);
  const where =
    requireManager && cols.managerRoleColumn
      ? and(subjectIsMember, eq(cols.managerRoleColumn, textLiteral(cols.managerRoleValue)))!
      : subjectIsMember;

  return sql`${cols.containerColumn} in (select ${cols.membershipContainerColumn} from ${cols.membershipTable} where ${where})`;
}

/** owner-or-manager predicate (edit / moderate). */
function ownerOrManager(cols: NormalizedMembershipColumns, subject: SQL): SQL {
  const owner = eq(cols.ownerColumn, subject);
  return cols.managerRoleColumn ? or(owner, membershipMatch(cols, subject, true))! : owner;
}

// write-state gate: ((container not locked) OR caller is a manager) AND caller's membership not muted.
// Same IN-containment discipline as membershipMatch, so the container/membership tables can reuse
// their own column names without shadowing the governed row's container column.
function membershipWriteGate(
  cols: NormalizedMembershipColumns,
  gate: SupabaseMembershipWriteGateColumns,
  subject: SQL,
): SQL {
  const unlocked = sql`${cols.containerColumn} in (select ${gate.containerPkColumn} from ${gate.containerTable} where ${eq(gate.containerLockColumn, FALSE_LITERAL)})`;
  const notMuted = sql`${cols.containerColumn} in (select ${cols.membershipContainerColumn} from ${cols.membershipTable} where ${and(eq(cols.membershipSubjectColumn, subject), eq(gate.membershipMutedColumn, FALSE_LITERAL))})`;
  return and(or(unlocked, membershipMatch(cols, subject, true))!, notMuted)!;
}

export function buildSupabaseMembershipNativePolicies(options: SupabaseMembershipNativePoliciesOptions) {
  const cols = normalizeMembershipColumns(options);
  const subject = buildSubjectSql(cols.subjectCastType);
  const tableName = governedTableName(cols.containerColumn);

  const memberPredicate = membershipMatch(cols, subject, false);
  const ownerAndMember = and(eq(cols.ownerColumn, subject), memberPredicate)!;
  const ownerOrManagerPredicate = ownerOrManager(cols, subject);

  let writeGateClause: SQL | null = null;
  if (options.writeGate) {
    if (!cols.managerRoleColumn) {
      throw new Error("writeGate requires managerRoleColumn so a manager can write into a locked container");
    }
    writeGateClause = membershipWriteGate(cols, options.writeGate, subject);
  }

  const gatedForWrite = (base: SQL): SQL => (writeGateClause ? and(base, writeGateClause)! : base);

  const predicateFor = (command: MembershipPolicyKind): SQL => {
    switch (command) {
      case "select":
        return memberPredicate;
      case "insert":
        return gatedForWrite(ownerAndMember);
      case "update":
        return gatedForWrite(ownerOrManagerPredicate);
      case "delete":
        return ownerOrManagerPredicate;
    }
  };

  return membershipPolicyShapes.map((shape) => {
    const predicate = predicateFor(shape.command);

    return pgPolicy(`${tableName}_${shape.command}_membership`, {
      as: "permissive",
      for: shape.command,
      to: options.role,
      ...(shape.using ? { using: predicate } : {}),
      ...(shape.withCheck ? { withCheck: predicate } : {}),
    });
  });
}
