import { Avatar, Badge, Button, Card, Group, Select, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { useMembershipActions, type MembershipActions } from "../admin/use-membership-actions";
import { useAuth } from "../auth/auth";
import { type MembershipRow, type ProfileRow, useProfileMap, useTeamMemberships, useTeams } from "../data";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// One Team's membership: the current members (each removable) plus an add control offering only the
// profiles not already in the Team. Add/remove are optimistic `team_member` writes (Admin-only); on
// the affected member's own client the whole Team — board + Channel — appears or leaves in one frame
// (board ADR-0004 team-scope consistency group).
function TeamMembersCard({
  teamId,
  teamName,
  memberships,
  profiles,
  candidates,
  actions,
}: {
  teamId: string;
  teamName: string;
  memberships: MembershipRow[];
  profiles: Map<string, ProfileRow>;
  candidates: ProfileRow[];
  actions: MembershipActions;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const memberRows = useMemo(
    () =>
      memberships
        .map((membership) => ({ membership, profile: profiles.get(membership.userId) }))
        .sort((a, b) => (a.profile?.displayName ?? "").localeCompare(b.profile?.displayName ?? "")),
    [memberships, profiles],
  );
  const options = useMemo(
    () => candidates.map((profile) => ({ value: profile.id, label: profile.displayName })),
    [candidates],
  );

  const add = async () => {
    if (selected == null || busy) return;
    setBusy(true);
    try {
      await actions.addMember(teamId, selected);
      setSelected(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="sm">
        <Title order={4}>{teamName}</Title>
        <Badge variant="light">{memberRows.length} members</Badge>
      </Group>
      <Stack gap="xs">
        {memberRows.length === 0 ? (
          <Text size="sm" c="dimmed">
            No members yet.
          </Text>
        ) : (
          memberRows.map(({ membership, profile }) => (
            <Group key={membership.id} justify="space-between" wrap="nowrap">
              <Group gap="sm" wrap="nowrap">
                <Avatar size="sm" radius="xl" color={profile?.avatarColor ?? "gray"}>
                  {profile != null ? initials(profile.displayName) : "?"}
                </Avatar>
                <Text size="sm">{profile?.displayName ?? membership.userId}</Text>
              </Group>
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                onClick={() => void actions.removeMember(membership.id)}
              >
                Remove
              </Button>
            </Group>
          ))
        )}
      </Stack>
      <Group gap="sm" mt="md" wrap="nowrap" align="flex-end">
        <Select
          flex={1}
          searchable
          clearable
          placeholder="Add a member…"
          aria-label={`Add a member to ${teamName}`}
          nothingFoundMessage="Everyone is already a member"
          data={options}
          value={selected}
          onChange={setSelected}
        />
        <Button onClick={() => void add()} disabled={selected == null} loading={busy}>
          Add
        </Button>
      </Group>
    </Card>
  );
}

// Admin-only membership management (board Phase 7). The Admin syncs every Team, membership, and
// profile (the admin bypass in each read filter), so this is the full roster. A non-admin who reaches
// the route is redirected home.
export function MembersRoute() {
  const { session, isAdmin } = useAuth();
  const navigate = useNavigate();
  const { teams } = useTeams();
  const memberships = useTeamMemberships();
  const profiles = useProfileMap();
  const actions = useMembershipActions();

  const membersByTeam = useMemo(() => {
    const map = new Map<string, MembershipRow[]>();
    for (const membership of memberships) {
      const list = map.get(membership.teamId);
      if (list != null) list.push(membership);
      else map.set(membership.teamId, [membership]);
    }
    return map;
  }, [memberships]);

  const candidatesByTeam = useMemo(() => {
    const allProfiles = [...profiles.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    const map = new Map<string, ProfileRow[]>();
    for (const team of teams) {
      const memberIds = new Set((membersByTeam.get(team.id) ?? []).map((membership) => membership.userId));
      map.set(
        team.id,
        allProfiles.filter((profile) => !memberIds.has(profile.id)),
      );
    }
    return map;
  }, [teams, profiles, membersByTeam]);

  useEffect(() => {
    if (session && !isAdmin) void navigate({ to: "/" });
  }, [session, isAdmin, navigate]);

  if (!isAdmin) return null;

  return (
    <Stack gap="md">
      <div>
        <Title order={2}>Members</Title>
        <Text c="dimmed">Add or remove Team members — the membership change fans out to that member live.</Text>
      </div>
      {teams.map((team) => (
        <TeamMembersCard
          key={team.id}
          teamId={team.id}
          teamName={team.name}
          memberships={membersByTeam.get(team.id) ?? []}
          profiles={profiles}
          candidates={candidatesByTeam.get(team.id) ?? []}
          actions={actions}
        />
      ))}
    </Stack>
  );
}
