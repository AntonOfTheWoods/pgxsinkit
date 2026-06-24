import { Center, Loader, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { useAuth } from "../auth/auth";
import { useAllIssues, useProfileMap, useTeams } from "../data";
import { BoardColumns } from "../features/board";

// Admin-only cross-team view: every Issue the store holds, labelled by Team. For an Admin the read
// path returns all rows (the admin bypass in every `*ReadFilter`), so this is "Admin sees all" made
// concrete. A non-admin who reaches it is redirected home.
export function AllRoute() {
  const { session, isAdmin } = useAuth();
  const navigate = useNavigate();
  const { issues, loading } = useAllIssues();
  const profiles = useProfileMap();
  const { teams } = useTeams();
  const teamNameById = useMemo(() => new Map(teams.map((team) => [team.id, team.name])), [teams]);

  useEffect(() => {
    if (session && !isAdmin) void navigate({ to: "/" });
  }, [session, isAdmin, navigate]);

  if (!isAdmin) return null;

  return (
    <Stack gap="md">
      <div>
        <Title order={2}>All teams</Title>
        <Text c="dimmed">Every Issue across every Team — the Admin global view.</Text>
      </div>
      {loading && issues.length === 0 ? (
        <Center h="30vh">
          <Loader />
        </Center>
      ) : (
        <BoardColumns issues={issues} profiles={profiles} teamNameById={teamNameById} />
      )}
    </Stack>
  );
}
