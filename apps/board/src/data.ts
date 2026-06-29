import { eq } from "drizzle-orm";
import { useMemo } from "react";

import {
  channelTable,
  issueTable,
  issueView,
  messageView,
  profileTable,
  teamMemberTable,
  teamTable,
} from "@pgxsinkit/board-schema";

import { useLiveDrizzleRows, useLiveRows } from "./board-client";

// The read surface over the local PGlite store. Readonly tables (profile/team/channel) are read from
// their synced local tables; readwrite tables (issue/message) from their `_read_model` views (which
// merge the synced cache with the optimistic overlay — relevant once Phase 5 adds writes). Every query
// is already scoped: the store only holds the rows `board-sync` streamed for the signed-in identity.
//
// `useLiveDrizzleRows` returns rows keyed by the select's field names (the hook remaps PGlite's raw
// snake_case columns back to the builder keys — packages/react/remap-live-row). NB the `created_at_us`
// bigint column is declared `mode: "bigint"`, so its inferred type is `bigint`, but PGlite returns int8
// as a string at runtime — hence `Number(...)` coercion where it's formatted (features/chat).

export const STATUS_ORDER = ["backlog", "todo", "in_progress", "done"] as const;
export type IssueStatus = (typeof STATUS_ORDER)[number];
export const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
};

export const PRIORITY_META: Record<string, { label: string; color: string }> = {
  urgent: { label: "Urgent", color: "red" },
  high: { label: "High", color: "orange" },
  medium: { label: "Medium", color: "yellow" },
  low: { label: "Low", color: "blue" },
  none: { label: "None", color: "gray" },
};

export type ProfileRow = { id: string; displayName: string; avatarColor: string };
export type IssueRow = {
  id: string;
  teamId: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
};
export type ChannelRow = { id: string; teamId: string | null; kind: string; name: string };

export function useTeams() {
  const { rows, loading } = useLiveDrizzleRows(
    (client) =>
      client.drizzle.select({ id: teamTable.id, name: teamTable.name }).from(teamTable).orderBy(teamTable.name),
    [],
  );
  return { teams: rows, loading };
}

/** id → profile, for assignee/author rendering. Every authenticated identity syncs all profiles. */
export function useProfileMap(): Map<string, ProfileRow> {
  const { rows } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({ id: profileTable.id, displayName: profileTable.displayName, avatarColor: profileTable.avatarColor })
        .from(profileTable),
    [],
  );
  return useMemo(() => {
    const map = new Map<string, ProfileRow>();
    for (const row of rows) map.set(row.id, row);
    return map;
  }, [rows]);
}

export type MembershipRow = { id: string; teamId: string; userId: string };

/**
 * Every Team membership the store holds. The read path already scopes this to the signed-in identity
 * (a Member syncs the memberships of their own Teams; an Admin syncs all), so callers just group the
 * rows by `teamId` to build per-Team assignee lists — no extra filtering needed. The membership `id`
 * is the `team_member` PK, used by the Admin members page to remove a membership by key (Phase 7).
 *
 * Read from the **base synced table**, not the `_read_model` view: `team_member` is `readwrite` only in
 * the Admin (authoritative) registry; the Member registry consumes it via `asReadonly` and so has no
 * overlay-merged view (pgxsinkit ADR-0025). The base table exists in both, so this one hook serves both
 * roles. Trade-off: an Admin's optimistic add/remove appears here once the Electric echo lands (a
 * round-trip), not instantly — acceptable, and the optimistic surface is already shown by issues.
 */
export function useTeamMemberships(): MembershipRow[] {
  const { rows } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({ id: teamMemberTable.id, teamId: teamMemberTable.teamId, userId: teamMemberTable.userId })
        .from(teamMemberTable),
    [],
  );
  return rows;
}

/** Group memberships into `teamId → member profiles` (sorted) for the per-card assignee menu. */
export function buildAssignableByTeam(
  memberships: readonly MembershipRow[],
  profiles: Map<string, ProfileRow>,
): Map<string, ProfileRow[]> {
  const map = new Map<string, ProfileRow[]>();
  for (const { teamId, userId } of memberships) {
    const profile = profiles.get(userId);
    if (profile == null) continue;
    const list = map.get(teamId);
    if (list != null) list.push(profile);
    else map.set(teamId, [profile]);
  }
  for (const list of map.values()) list.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return map;
}

const issueColumns = {
  id: issueView.id,
  teamId: issueView.teamId,
  assigneeId: issueView.assigneeId,
  title: issueView.title,
  status: issueView.status,
  priority: issueView.priority,
} as const;

export function useTeamIssues(teamId: string) {
  const { rows, loading } = useLiveDrizzleRows(
    (client) => client.drizzle.select(issueColumns).from(issueView).where(eq(issueView.teamId, teamId)),
    [teamId],
  );
  return { issues: rows, loading };
}

/** Admin cross-team view: every Issue the store holds (an Admin syncs them all). */
export function useAllIssues() {
  const { rows, loading } = useLiveDrizzleRows((client) => client.drizzle.select(issueColumns).from(issueView), []);
  return { issues: rows, loading };
}

export type ServerIssueValue = { status: string; assigneeId: string | null };

/**
 * The **server** value of every Issue, read straight from the synced base table (`issue`) — NOT the
 * `issue_read_model` view the board renders, which merges the optimistic overlay on top. The two
 * diverge exactly when a local write has not yet converged; the conflict surface shows this value as
 * "the server moved it to …" against the optimistic value still on the card (board Phase 6).
 */
export function useServerIssueValues(): Map<string, ServerIssueValue> {
  const { rows } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({ id: issueTable.id, status: issueTable.status, assigneeId: issueTable.assigneeId })
        .from(issueTable),
    [],
  );
  return useMemo(() => {
    const map = new Map<string, ServerIssueValue>();
    for (const row of rows) map.set(row.id, { status: row.status, assigneeId: row.assigneeId });
    return map;
  }, [rows]);
}

export type IssueConvergence = {
  /** The reject-if-stale rejection reason while a write is `conflicted`, else null (ADR-0015). */
  conflictState: string | null;
  /** Retryable writes still owed to the server (pending/sending/failed) — drives the "syncing" dot. */
  pendingCount: number;
  /** Terminal writes the server permanently rejected (ADR-0006); surfaced in the Inspector (Phase 8). */
  quarantinedCount: number;
  quarantineState: string | null;
};

type SyncStateRow = {
  id: string;
  conflict_state: string | null;
  pending_count: number;
  quarantined_count: number;
  quarantine_state: string | null;
};

/**
 * Per-Issue convergence state from the toolkit's derived `issue_sync_state` view (ADR-0011): one row
 * per Issue that has any local activity. A live raw query (the view isn't a Drizzle object) — the
 * board reads `conflict_state` to surface reject-if-stale conflicts inline (Phase 6) and
 * `pending_count`/`quarantined_count` for the convergence dots + Inspector (Phase 8).
 */
export function useIssueConvergence(): Map<string, IssueConvergence> {
  const { rows } = useLiveRows<SyncStateRow>(
    "SELECT id, conflict_state, pending_count, quarantined_count, quarantine_state FROM issue_sync_state",
  );
  return useMemo(() => {
    const map = new Map<string, IssueConvergence>();
    for (const row of rows) {
      map.set(row.id, {
        conflictState: row.conflict_state,
        pendingCount: Number(row.pending_count),
        quarantinedCount: Number(row.quarantined_count),
        quarantineState: row.quarantine_state,
      });
    }
    return map;
  }, [rows]);
}

export function useChannels() {
  const { rows, loading } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({ id: channelTable.id, teamId: channelTable.teamId, kind: channelTable.kind, name: channelTable.name })
        .from(channelTable)
        .orderBy(channelTable.kind, channelTable.name),
    [],
  );
  return { channels: rows, loading };
}

export function useChannelMessages(channelId: string) {
  const { rows, loading } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({
          id: messageView.id,
          authorId: messageView.authorId,
          body: messageView.body,
          createdAtUs: messageView.createdAtUs,
        })
        .from(messageView)
        .where(eq(messageView.channelId, channelId))
        .orderBy(messageView.createdAtUs),
    [channelId],
  );
  return { messages: rows, loading };
}
