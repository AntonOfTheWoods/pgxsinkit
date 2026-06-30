import { sql, type SQL } from "drizzle-orm";

import {
  asEphemeral,
  asReadonly,
  assertReadContractPreserved,
  c,
  defineSyncRegistry,
  DENY_ALL,
  type JwtClaims,
} from "@pgxsinkit/contracts";

import {
  channelSyncEntry,
  issueSyncEntry,
  messageSyncEntry,
  profileSyncEntry,
  teamMemberSyncEntry,
  teamSyncEntry,
} from "./schema";

const team = teamSyncEntry.table;
const teamMember = teamMemberSyncEntry.table;
const channel = channelSyncEntry.table;
const issue = issueSyncEntry.table;
const message = messageSyncEntry.table;

function isAdmin(claims: JwtClaims): boolean {
  return claims.app_metadata?.roles?.includes("admin") ?? false;
}

// The read-path twin of the RLS `memberOfTeam` predicate (policies.ts), but over the literal claim:
// Electric runs this `where`, not Postgres, so there is no `auth.uid()` here. Built from the real
// Drizzle columns — bare via `c()` (Electric's where-grammar needs plain, unqualified refs) with the
// subject as a bound param (`$1`), never a hand-escaped literal. enum columns must be cast to text
// (Electric's grammar) — see `channelReadFilter`.
function memberTeams(sub: string) {
  return sql`select ${c(teamMember.teamId)} from ${teamMember} where ${c(teamMember.userId)} = ${sub}`;
}

// Every authenticated user syncs all profiles (to render any author/assignee); nobody otherwise.
function profileReadFilter(claims: JwtClaims): SQL | null {
  return claims.sub ? null : DENY_ALL;
}

function teamReadFilter(claims: JwtClaims) {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return DENY_ALL;
  return sql`${c(team.id)} in (${memberTeams(claims.sub)})`;
}

function teamMemberReadFilter(claims: JwtClaims) {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return DENY_ALL;
  // Fan-out: you sync every membership of your Teams, so you can see your co-members (assignee lists).
  return sql`${c(teamMember.teamId)} in (${memberTeams(claims.sub)})`;
}

function channelReadFilter(claims: JwtClaims) {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return DENY_ALL;
  return sql`${c(channel.kind)}::text = 'global' or ${c(channel.teamId)} in (${memberTeams(claims.sub)})`;
}

function issueReadFilter(claims: JwtClaims) {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return DENY_ALL;
  return sql`${c(issue.teamId)} in (${memberTeams(claims.sub)})`;
}

// The Member chat read window (pgxsinkit ADR-0025 read-path filter): a Member syncs only the recent
// window — chat from the last `CHAT_WINDOW_DAYS` — while the Admin syncs the full history. The seed
// spreads chat across ~30 days, so older messages always fall outside this window and are visibly
// admin-only (sign in as a member: the channel shows recent chat; as the admin: the full backlog). The
// cutoff is **day-quantized** — midnight (UTC), `CHAT_WINDOW_DAYS` back, in microseconds — so the Electric
// shape `where`/param is stable within a day (clients share one shape cache; the window slides once daily)
// instead of minting a new shape on every subscribe. Evaluated in the proxy per request. The windowed
// branch is Member-only, and the Member projects `message` to `ephemeral` (its shape cache dies with the
// session), so the daily-sliding cutoff needs no `rowFilter.revision` bump; the Admin branch is static
// full-history (`null`), so its `persistent` cache never goes stale from this either.
const MS_PER_DAY = 86_400_000;
const CHAT_WINDOW_DAYS = 21;
function memberChatWindowCutoffMicros(): bigint {
  const startOfTodayMs = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;
  return BigInt(startOfTodayMs - CHAT_WINDOW_DAYS * MS_PER_DAY) * 1000n;
}

function messageReadFilter(claims: JwtClaims) {
  if (isAdmin(claims)) return null; // Admin syncs every channel and the full chat history.
  if (!claims.sub) return DENY_ALL;
  const visibleChannels = sql`select ${c(channel.id)} from ${channel} where ${c(channel.kind)}::text = 'global' or ${c(channel.teamId)} in (${memberTeams(claims.sub)})`;
  // A Member syncs their visible channels AND only the recent window (`CHAT_WINDOW_DAYS`); chat older
  // than that streams to the Admin but not to members — the read-path twin of the demo's role split.
  return sql`${c(message.channelId)} in (${visibleChannels}) and ${c(message.createdAtUs)} >= ${memberChatWindowCutoffMicros()}`;
}

/**
 * The board sync registry — the single contract the client, the `board-sync` proxy, and the
 * `board-write` API all consume. Each entry carries its read-path `customWhere` (applied by the
 * proxy); the write-path RLS lives on the tables (schema.ts / policies.ts). The two are deliberate
 * mirrors: read filters and write policies derive from the same member-of-team / channel-visibility /
 * admin predicates so a row can never be visible-but-unwritable or vice versa by accident.
 */
export const boardSyncRegistry = defineSyncRegistry({
  profile: {
    ...profileSyncEntry,
    shape: { ...profileSyncEntry.shape!, rowFilter: { customWhere: profileReadFilter } },
  },
  team: {
    ...teamSyncEntry,
    shape: { ...teamSyncEntry.shape!, rowFilter: { customWhere: teamReadFilter } },
  },
  team_member: {
    ...teamMemberSyncEntry,
    shape: { ...teamMemberSyncEntry.shape!, rowFilter: { customWhere: teamMemberReadFilter } },
  },
  channel: {
    ...channelSyncEntry,
    shape: { ...channelSyncEntry.shape!, rowFilter: { customWhere: channelReadFilter } },
  },
  issue: {
    ...issueSyncEntry,
    shape: { ...issueSyncEntry.shape!, rowFilter: { customWhere: issueReadFilter } },
  },
  message: {
    ...messageSyncEntry,
    shape: { ...messageSyncEntry.shape!, rowFilter: { customWhere: messageReadFilter } },
  },
});

/**
 * Per-role client projections (pgxsinkit ADR-0025). `boardSyncRegistry` above is the **authoritative**
 * registry — the `board-sync` proxy, the `board-write` apply function, and `pgxsinkit-generate` all
 * consume it, and `team` / `team_member` are `readwrite` there (their write contract + RLS live on the
 * tables). A client consumes a *projection* of it, chosen by role at bootstrap (board-client.ts):
 *
 * - **Admin** writes Teams (rename) and memberships (add/remove) — it uses the authoritative registry.
 * - **Member** only reads both — `asReadonly` strips the local write machinery (no overlay/journal, no
 *   `client.tables.team{,_member}` write handle, no `_read_model` view) while preserving the read
 *   contract, so a member can never optimistically apply a write that RLS would only quarantine.
 * - **Chat retention** also differs by role (ADR-0021 lifecycle projection): the authoritative `message`
 *   is `persistent` — the Admin's durable, promote-on-first-use `lazy` full history — and the Member
 *   projects it through `asEphemeral`, so a Member's chat lives in a `TEMP` cluster and leaves no durable
 *   trace. Retention is a lifecycle axis the read-contract invariant ignores, so this projection still
 *   passes `assertReadContractPreserved`.
 *
 * The read filters above already branch on `isAdmin`, so the one authoritative registry serves both
 * roles' shapes; the client's *write capability* (team/team_member) and *retention* (message) differ,
 * which is exactly what a per-client projection expresses.
 */
export const boardAdminRegistry = boardSyncRegistry;

export const boardMemberRegistry = defineSyncRegistry({
  ...boardSyncRegistry,
  team: asReadonly(boardSyncRegistry.team),
  team_member: asReadonly(boardSyncRegistry.team_member),
  message: asEphemeral(boardSyncRegistry.message),
});

// Fail closed if a projection ever diverges the data it syncs (columns / pk / row-filter shape) — a
// member and an admin must see the same rows through the same tables, differing only in write rights and
// lifecycle (here, chat retention).
assertReadContractPreserved(boardSyncRegistry, boardMemberRegistry, { label: "board member" });
