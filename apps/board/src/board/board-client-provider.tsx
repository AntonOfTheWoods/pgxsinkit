import { Center, Loader, Stack, Text } from "@mantine/core";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import type { SyncRuntimeStatus } from "@pgxsinkit/contracts";

import { createBoardSyncClient, SyncClientProvider } from "../board-client";
import type { OfflineControl } from "./offline";
import { createPgliteProfiler } from "./pglite-profiler";

type BoardSyncClient = Awaited<ReturnType<typeof createBoardSyncClient>>["client"];

// The live sync status (booting/syncing/ready/degraded/auth-needed) for the header badge. Defaults to
// `null` so a component may read it outside the provider (e.g. the header on the login screen) without
// throwing — it simply renders nothing.
const BoardSyncStatusContext = createContext<SyncRuntimeStatus | null>(null);
// The Offline toggle control (board Phase 8). `null` outside the provider (login screen).
const BoardOfflineContext = createContext<OfflineControl | null>(null);

export function useBoardSyncStatus(): SyncRuntimeStatus | null {
  return useContext(BoardSyncStatusContext);
}

export function useBoardOffline(): OfflineControl | null {
  return useContext(BoardOfflineContext);
}

/**
 * Boots the board's sync client for the signed-in identity: opens the local PGlite store, applies the
 * registry schema, and starts streaming the `board-sync` shapes the identity is allowed to see. Mount
 * it keyed by `userId` so each identity gets its own local store. Children render once the client is
 * ready; rows then arrive reactively (`useLiveRows`) as the initial sync streams in.
 */
export function BoardClientProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [client, setClient] = useState<BoardSyncClient | null>(null);
  const [offline, setOffline] = useState<OfflineControl | null>(null);
  const [status, setStatus] = useState<SyncRuntimeStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    let created: BoardSyncClient | undefined;
    setClient(null);
    setOffline(null);
    setStatus(null);
    setError(null);

    void (async () => {
      try {
        const { client: next, offline: nextOffline } = await createBoardSyncClient(userId, (value) => {
          if (active) setStatus(value);
        });
        await next.ready;
        if (!active) {
          void next.stop();
          return;
        }
        created = next;
        setOffline(nextOffline);
        // Dev-only console handles. `__boardClient` pokes the live client (stage a conflict, inspect
        // convergence, flush on demand); `__boardProfiler` is the aggregated PGlite query profiler
        // (start()/stop() → which statements cost what — the managed alternative to PGlite's
        // all-or-nothing logging). Never shipped — gated on the Vite dev build.
        if (import.meta.env.DEV) {
          const dev = globalThis as typeof globalThis & {
            __boardClient?: BoardSyncClient;
            __boardProfiler?: ReturnType<typeof createPgliteProfiler>;
          };
          dev.__boardClient = next;
          dev.__boardProfiler = createPgliteProfiler(next.pglite);
        }
        setStatus(next.status);
        setClient(next);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    })();

    return () => {
      active = false;
      if (created) void created.stop();
      if (import.meta.env.DEV) {
        const dev = globalThis as typeof globalThis & {
          __boardClient?: BoardSyncClient;
          __boardProfiler?: ReturnType<typeof createPgliteProfiler>;
        };
        delete dev.__boardClient;
        delete dev.__boardProfiler;
      }
    };
  }, [userId]);

  if (error) {
    return (
      <Center h="60vh">
        <Stack align="center" gap="xs" maw={420}>
          <Text c="red" fw={600}>
            Could not start the local sync engine
          </Text>
          <Text c="dimmed" size="sm" ta="center">
            {error.message}
          </Text>
        </Stack>
      </Center>
    );
  }

  if (!client) {
    return (
      <Center h="60vh">
        <Stack align="center" gap="xs">
          <Loader />
          <Text c="dimmed" size="sm">
            Starting local database + initial sync…
          </Text>
        </Stack>
      </Center>
    );
  }

  return (
    <BoardSyncStatusContext.Provider value={status}>
      <BoardOfflineContext.Provider value={offline}>
        <SyncClientProvider client={client}>{children}</SyncClientProvider>
      </BoardOfflineContext.Provider>
    </BoardSyncStatusContext.Provider>
  );
}
