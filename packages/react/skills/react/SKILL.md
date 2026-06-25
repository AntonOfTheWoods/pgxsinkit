---
name: react
description: >-
  Load when wiring @pgxsinkit/react into a React app — createSyncClientHooks and the reactive read hooks
  (useLiveRows, useLiveRow, useLiveDrizzleRows, useLiveDrizzleRow) plus SyncClientProvider /
  useSyncClient. Teaches that live reads are event-driven off PGlite's live.query (they fire on commit,
  not on a poll), that useLiveDrizzleRows remaps snake_case columns back to the builder's field keys
  while raw useLiveRows returns underlying column names, the { rows, loading, error } contract, and that
  writes go through client.tables.<t> (not the hooks) and flush on enqueue. Load before building React
  components that read or write synced data.
metadata:
  type: framework
  framework: react
  library: "@pgxsinkit/react"
  library_version: "0.1.32"
  source: https://pgxsinkit.github.io/
requires:
  - react
---

# Using @pgxsinkit/react

Create one set of registry-typed hooks at module scope and provide the client at the root:

```ts
export const { SyncClientProvider, useSyncClient, useLiveRows, useLiveDrizzleRows } =
  createSyncClientHooks<typeof registry>();
```

Wrap your tree in `<SyncClientProvider client={client}>`; components then read the local store
reactively and write through the client.

## Reads are reactive and event-driven (not polled)

The live hooks register a PGlite `live.query`. When the sync engine applies a change to PGlite, the live
query re-runs and the hook re-renders — **on commit, not on an interval**. Do not add a `setInterval` to
"refresh" a live query; it is already reactive, and polling PGlite is actively harmful (every query is
~50ms of WASM work on one thread — see the `operating` skill).

Every read hook returns `{ rows, loading, error }` (singular variants return `{ row, ... }`). Pass
`ready: false` to defer a query until a dependency is available.

## Prefer `useLiveDrizzleRows` for typed, correctly-keyed rows

PGlite returns rows keyed by the underlying **snake_case** column names. `useLiveDrizzleRows` takes a
Drizzle select builder and **remaps** those back to the builder's (camelCase) field keys, so the rows
match the inferred type with no casts:

```ts
const { rows } = useLiveDrizzleRows((c) => c.drizzle.select().from(c.views.todos), []);
```

Raw `useLiveRows(sql, { params })` does **no** remap — its rows carry the raw DB column names. Use it for
ad-hoc SQL where you control the column names; prefer `useLiveDrizzleRows` for typed reads. The Drizzle
builder is rebuilt when the `deps` array changes (same contract as `useEffect`).

## Writes go through `client.tables`, not the hooks

The read hooks are read-only. Mutate via `client.tables.<table>.create/update/delete` (or
`useSyncClient()` inside a component). Each call stages an optimistic local write (the live query
re-renders this frame) and **flushes on enqueue** — the optimistic overlay clears when the server value
streams back through Electric. See the `core` skill for the write model and `operating` for convergence
cadence and the `globalThis.__pgxsinkitDebug` latency instrumentation.

## Common mistakes

- Expecting `useLiveRows` to return camelCase keys — it returns raw DB column names; use
  `useLiveDrizzleRows` for remapped, typed rows.
- Polling PGlite (`setInterval` re-reads) to "watch" data — the hooks are already reactive, and polling
  saturates the single WASM thread.
- Mutating local tables directly instead of through `client.tables.<t>` (the one write path).
- Reading before the client is ready instead of gating with `ready: false`.

Reference: <https://pgxsinkit.github.io/>.
