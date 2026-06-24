import { Center, Loader } from "@mantine/core";
import { useParams } from "@tanstack/react-router";

import { TeamPageShell } from "../components/team-page-shell";
import { useProfileMap, useTeamIssues } from "../data";
import { BoardColumns } from "../features/board";

export function TeamBoardRoute() {
  const { teamId } = useParams({ from: "/team/$teamId/board" });
  const { issues, loading } = useTeamIssues(teamId);
  const profiles = useProfileMap();

  return (
    <TeamPageShell teamId={teamId} tab="board">
      {loading && issues.length === 0 ? (
        <Center h="30vh">
          <Loader />
        </Center>
      ) : (
        <BoardColumns issues={issues} profiles={profiles} />
      )}
    </TeamPageShell>
  );
}
