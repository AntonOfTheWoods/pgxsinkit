import { Group, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useTeams } from "../data";

// Header + Board/Chat switch shared by the two per-team routes. If the Team isn't in the local store
// (a member navigating to a Team they don't belong to), the read path simply never synced it — shown
// as an explicit empty state, which is itself the scoping made visible.
export function TeamPageShell({
  teamId,
  tab,
  children,
}: {
  teamId: string;
  tab: "board" | "chat";
  children: ReactNode;
}) {
  const { teams } = useTeams();
  const navigate = useNavigate();
  const team = teams.find((candidate) => candidate.id === teamId);

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>{team?.name ?? "Team"}</Title>
        <SegmentedControl
          value={tab}
          onChange={(value) =>
            void navigate(
              value === "chat"
                ? { to: "/team/$teamId/chat", params: { teamId } }
                : { to: "/team/$teamId/board", params: { teamId } },
            )
          }
          data={[
            { label: "Board", value: "board" },
            { label: "Chat", value: "chat" },
          ]}
        />
      </Group>
      {team == null ? (
        <Text c="dimmed">This team isn&apos;t in your synced workspace — you&apos;re not a member.</Text>
      ) : (
        children
      )}
    </Stack>
  );
}
