import { sql } from "drizzle-orm";
import { pgPolicy, type PgRole } from "drizzle-orm/pg-core";

/**
 * Hand-authored board RLS (board ADR-0005). The board is collaborative — any Member may edit any
 * Issue in a Team they belong to — so it deliberately does NOT use
 * `buildSupabaseMembershipNativePolicies`, which gates writes to owner-or-manager. Three reused
 * predicates compose every policy: member-of-team, the channel-visibility two-hop, and the global
 * Admin bypass.
 *
 * Subject is `auth.uid()` (the JWT `sub`); membership is `board_member_team_ids()` — a SECURITY
 * DEFINER helper (its own migration) that reads `team_member` with RLS bypassed, so a membership
 * predicate ON `team_member` itself (or in the issue/message policies that read it) does not recurse
 * into team_member's RLS (`42P17 infinite recursion`); Admin is the inlined `BOARD_ADMIN_PREDICATE_SQL`.
 * All read `request.jwt.claims`, which the Mutation applier sets before applying a batch. These run
 * on the **write path** (Postgres-with-JWT). The **read path** filters the same way but over the
 * literal claim value (`escapeSqlLiteral(claims.sub)`) in the proxy `customWhere` (registry.ts),
 * because Electric runs that `where`, not Postgres — keep the two in sync.
 *
 * The readonly tables (profile/team/channel) carry SELECT-only policies: their reads are governed
 * the same way, and the absence of any write policy denies writes at the DB layer — Supabase's
 * default privileges grant `authenticated` broad DML, so the grant alone does not make a table
 * read-only; RLS does. The membership helper, the inlined Admin predicate, and the cross-team-move
 * trigger are server authority, never local — the Parity boundary.
 */

// Admin = `app_metadata.roles` contains 'admin'. **Inlined**, not a SQL helper function: it reads no
// table (only `request.jwt.claims`), so it has no recursion risk and inlining keeps it free of the
// ordering trap — a `CREATE POLICY` referencing a function needs that function to exist first.
// Reads `request.jwt.claims` (the same source as `auth.uid()`), which the Mutation applier sets
// before applying a batch. The cross-team-move trigger reuses this predicate in PL/pgSQL.
export const BOARD_ADMIN_PREDICATE_SQL =
  "EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin')";

const ADMIN = BOARD_ADMIN_PREDICATE_SQL;

type Command = "select" | "insert" | "update" | "delete";

// `<teamColumn> IN (the teams the caller belongs to)`. Membership DOES need a table read
// (`team_member`), and inlining it recurses (see board_member_team_ids' migration), so unlike ADMIN
// this one routes through the SECURITY DEFINER helper. The helper is created by a migration that runs
// *before* the policy migration, so the ordering trap is handled — see db:board:migrate sequence.
function memberOfTeam(teamColumn: string): string {
  return `${teamColumn} IN (SELECT board_member_team_ids())`;
}

function policy(
  name: string,
  command: Command,
  role: PgRole,
  predicate: string,
  parts: { using?: boolean; withCheck?: boolean },
) {
  return pgPolicy(name, {
    as: "permissive",
    for: command,
    to: role,
    ...(parts.using ? { using: sql.raw(predicate) } : {}),
    ...(parts.withCheck ? { withCheck: sql.raw(predicate) } : {}),
  });
}

/**
 * profile: every authenticated identity may read every profile (to render any assignee/author);
 * no client writes (profiles are provisioned server-side from the GoTrue identity). SELECT-only —
 * the missing write policies deny INSERT/UPDATE/DELETE at the DB layer. Mirrors `profileReadFilter`.
 */
export function buildProfilePolicies(role: PgRole) {
  return [policy("profile_select", "select", role, "auth.uid() IS NOT NULL", { using: true })];
}

/**
 * team: a Member reads the Teams they belong to; an Admin reads all. Readonly — no write policies,
 * so neither the write path nor a direct connection can mutate teams. Mirrors `teamReadFilter`.
 */
export function buildTeamPolicies(role: PgRole) {
  const memberOrAdmin = `(${memberOfTeam("id")}) OR ${ADMIN}`;
  return [policy("team_select", "select", role, memberOrAdmin, { using: true })];
}

/**
 * channel: readable in a global Channel or a Channel of one of your Teams; an Admin reads all.
 * Readonly — no write policies. Mirrors `channelReadFilter`; this SELECT policy is also what the
 * `message` policies' `channel` sub-select resolves against now that channel RLS is enabled.
 */
export function buildChannelPolicies(role: PgRole) {
  const visibleOrAdmin = `(kind = 'global' OR ${memberOfTeam("team_id")}) OR ${ADMIN}`;
  return [policy("channel_select", "select", role, visibleOrAdmin, { using: true })];
}

/**
 * Issue: any Member of the Issue's Team may read and write it; an Admin may do so on any Team.
 * Cross-team move (changing `team_id`) is blocked for non-Admins by the `BEFORE UPDATE` trigger in
 * the board migration — an RLS policy cannot compare `OLD.team_id` to `NEW.team_id`.
 */
export function buildIssuePolicies(role: PgRole) {
  const memberOrAdmin = `(${memberOfTeam("team_id")}) OR ${ADMIN}`;
  return [
    policy("issue_select", "select", role, memberOrAdmin, { using: true }),
    policy("issue_insert", "insert", role, memberOrAdmin, { withCheck: true }),
    policy("issue_update", "update", role, memberOrAdmin, { using: true, withCheck: true }),
    policy("issue_delete", "delete", role, memberOrAdmin, { using: true }),
  ];
}

/** team_member: a Member sees co-members of their Teams; only an Admin may add/remove members. */
export function buildTeamMemberPolicies(role: PgRole) {
  const memberOrAdmin = `(${memberOfTeam("team_id")}) OR ${ADMIN}`;
  return [
    policy("team_member_select", "select", role, memberOrAdmin, { using: true }),
    policy("team_member_insert", "insert", role, ADMIN, { withCheck: true }),
    policy("team_member_update", "update", role, ADMIN, { using: true, withCheck: true }),
    policy("team_member_delete", "delete", role, ADMIN, { using: true }),
  ];
}

/**
 * Message: readable/writable in a global Channel or a Channel of one of your Teams (the two-hop
 * `message → channel → team` container); you may edit/delete only your own Message; Admin moderates.
 */
export function buildMessagePolicies(role: PgRole) {
  const channelVisible = `channel_id IN (SELECT id FROM channel WHERE kind = 'global' OR ${memberOfTeam("team_id")})`;
  const visibleOrAdmin = `(${channelVisible}) OR ${ADMIN}`;
  const authorOrAdmin = `author_id = auth.uid() OR ${ADMIN}`;
  return [
    policy("message_select", "select", role, visibleOrAdmin, { using: true }),
    policy("message_insert", "insert", role, visibleOrAdmin, { withCheck: true }),
    policy("message_update", "update", role, authorOrAdmin, { using: true, withCheck: true }),
    policy("message_delete", "delete", role, authorOrAdmin, { using: true }),
  ];
}
