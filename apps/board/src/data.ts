import { useMemo } from "react";

import { useLiveRows } from "./board-client";

// The read surface over the local PGlite store. Readonly tables (profile/team/channel) are read from
// their synced local tables; readwrite tables (issue/message) from their `_read_model` views (which
// merge the synced cache with the optimistic overlay — relevant once Phase 5 adds writes). Every query
// is already scoped: the store only holds the rows `board-sync` streamed for the signed-in identity.
//
// NB: we use `useLiveRows` (raw SQL) rather than `useLiveDrizzleRows`. The Drizzle hook runs the
// builder's `.toSQL()` straight through PGlite's live query and casts the result to the builder's
// (camelCase) row type — but PGlite returns the underlying snake_case column names, so a column like
// `assignee_id` arrives as `assignee_id`, not `assigneeId`, and the typed access is silently
// `undefined`. Until that's fixed upstream, we alias columns explicitly in SQL (`… AS "assigneeId"`),
// which is honest about the store and keeps the components camelCase. (Board dogfooding finding.)

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

export type TeamRow = {
  id: string;
  name: string;
};

export type ProfileRow = {
  id: string;
  displayName: string;
  avatarColor: string;
};

export type IssueRow = {
  id: string;
  teamId: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
};

export type ChannelRow = {
  id: string;
  teamId: string | null;
  kind: string;
  name: string;
};

export type MessageRow = {
  id: string;
  channelId: string;
  authorId: string;
  body: string;
  createdAtUs: string;
};

const ISSUE_COLS = `id, team_id AS "teamId", assignee_id AS "assigneeId", title, status, priority`;

export function useTeams() {
  const { rows, loading } = useLiveRows<TeamRow>(`SELECT id, name FROM team ORDER BY name`);
  return { teams: rows, loading };
}

/** id → profile, for assignee/author rendering. Every authenticated identity syncs all profiles. */
export function useProfileMap(): Map<string, ProfileRow> {
  const { rows } = useLiveRows<ProfileRow>(
    `SELECT id, display_name AS "displayName", avatar_color AS "avatarColor" FROM profile`,
  );
  return useMemo(() => {
    const map = new Map<string, ProfileRow>();
    for (const row of rows) map.set(row.id, row);
    return map;
  }, [rows]);
}

export function useTeamIssues(teamId: string) {
  const { rows, loading } = useLiveRows<IssueRow>(`SELECT ${ISSUE_COLS} FROM issue_read_model WHERE team_id = $1`, {
    params: [teamId],
  });
  return { issues: rows, loading };
}

/** Admin cross-team view: every Issue the store holds (an Admin syncs them all). */
export function useAllIssues() {
  const { rows, loading } = useLiveRows<IssueRow>(`SELECT ${ISSUE_COLS} FROM issue_read_model`);
  return { issues: rows, loading };
}

export function useChannels() {
  const { rows, loading } = useLiveRows<ChannelRow>(
    `SELECT id, team_id AS "teamId", kind, name FROM channel ORDER BY kind, name`,
  );
  return { channels: rows, loading };
}

export function useChannelMessages(channelId: string) {
  const { rows, loading } = useLiveRows<MessageRow>(
    `SELECT id, channel_id AS "channelId", author_id AS "authorId", body, created_at_us AS "createdAtUs" FROM message_read_model WHERE channel_id = $1 ORDER BY created_at_us`,
    { params: [channelId] },
  );
  return { messages: rows, loading };
}
