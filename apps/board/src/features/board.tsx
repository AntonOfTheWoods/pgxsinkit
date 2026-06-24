import { Avatar, Badge, Card, Group, Stack, Text, Tooltip } from "@mantine/core";

import { type IssueRow, PRIORITY_META, type ProfileRow, STATUS_LABEL, STATUS_ORDER } from "../data";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function AssigneeAvatar({ profile }: { profile: ProfileRow | undefined }) {
  if (profile == null) {
    return (
      <Tooltip label="Unassigned">
        <Avatar size="sm" radius="xl" color="gray" variant="light">
          ?
        </Avatar>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={profile.displayName}>
      <Avatar size="sm" radius="xl" color={profile.avatarColor}>
        {initials(profile.displayName)}
      </Avatar>
    </Tooltip>
  );
}

export function IssueCard({
  issue,
  profiles,
  teamName,
}: {
  issue: IssueRow;
  profiles: Map<string, ProfileRow>;
  teamName?: string;
}) {
  const priority = PRIORITY_META[issue.priority] ?? PRIORITY_META["none"]!;
  return (
    <Card withBorder padding="sm" radius="md">
      <Stack gap={8}>
        <Text size="sm" fw={500} lineClamp={2}>
          {issue.title}
        </Text>
        <Group justify="space-between" gap="xs">
          <Group gap={6}>
            {issue.priority !== "none" && (
              <Badge size="xs" variant="light" color={priority.color}>
                {priority.label}
              </Badge>
            )}
            {teamName != null && (
              <Badge size="xs" variant="outline" color="gray">
                {teamName}
              </Badge>
            )}
          </Group>
          <AssigneeAvatar profile={issue.assigneeId != null ? profiles.get(issue.assigneeId) : undefined} />
        </Group>
      </Stack>
    </Card>
  );
}

/**
 * The status-column board surface (read-only in Phase 4; Phase 5 makes the cards draggable). Pass
 * `teamNameById` for the cross-team `/all` view so each card is labelled with its Team.
 */
export function BoardColumns({
  issues,
  profiles,
  teamNameById,
}: {
  issues: readonly IssueRow[];
  profiles: Map<string, ProfileRow>;
  teamNameById?: Map<string, string>;
}) {
  return (
    <Group align="flex-start" gap="md" wrap="nowrap" style={{ overflowX: "auto" }}>
      {STATUS_ORDER.map((status) => {
        const columnIssues = issues.filter((issue) => issue.status === status);
        return (
          <Stack key={status} gap="xs" miw={264} w={264}>
            <Group justify="space-between" px={4}>
              <Text size="sm" fw={600}>
                {STATUS_LABEL[status]}
              </Text>
              <Badge size="sm" variant="default">
                {columnIssues.length}
              </Badge>
            </Group>
            <Stack gap="xs">
              {columnIssues.map((issue) => {
                const teamName = teamNameById?.get(issue.teamId);
                return (
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    profiles={profiles}
                    {...(teamName != null ? { teamName } : {})}
                  />
                );
              })}
              {columnIssues.length === 0 && (
                <Text size="xs" c="dimmed" px={4}>
                  No issues
                </Text>
              )}
            </Stack>
          </Stack>
        );
      })}
    </Group>
  );
}
