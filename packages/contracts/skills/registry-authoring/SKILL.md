---
name: registry-authoring
description: >-
  Load when defining or changing a pgxsinkit sync registry with @pgxsinkit/contracts —
  defineSyncRegistry / defineSyncTable, table sync modes, managed fields, conflict policy, read-path row
  filters, and RLS. Teaches the rules that throw or fail closed if missed: every readwrite table needs a
  server-version managed field plus a conflictPolicy (no default), authUid/nowMicroseconds fields are
  server-assigned and rejected in client payloads, enum columns in a shape where must be cast to text,
  the read filter and the RLS policy must derive from one predicate, and the in-database apply function
  is provisioned by the pgxsinkit-generate CLI as a drizzle-kit migration. Load before authoring a
  registry, adding a writable table, or wiring row-level security.
metadata:
  type: core
  library: "@pgxsinkit/contracts"
  library_version: "0.1.32"
  source: https://pgxsinkit.github.io/start/getting-started/
---

# Authoring a pgxsinkit registry

The registry (`defineSyncRegistry` over `defineSyncTable`) is the single source of truth both paths read
from — the read proxy and the write apply function are generated from it, so getting the registry right
is what keeps read and write authorization from drifting.

## Writable tables have two hard requirements (or it throws)

`defineSyncRegistry` **throws** unless every `mode: "readwrite"` table declares **both**:

1. A **server version** — a `nowMicroseconds`-on-`update` managed field, conventionally `updated_at_us`
   (a `bigint` microsecond column). Optimistic convergence keys on it; the `reject-if-stale` conflict
   policy compares the write's base version against it.
2. A **`conflictPolicy`** — `"reject-if-stale"` or `"last-write-wins"`. There is **no silent default**,
   because a silent last-write-wins is exactly the data loss the choice exists to surface.

```ts
widgets: defineSyncTable({
  tableName: "widgets",
  mode: "readwrite",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    label: varchar("label", { length: 120 }).notNull(),
    ownerId: uuid("owner_id"),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicros),
  }),
  conflictPolicy: "reject-if-stale", // REQUIRED — no default
  governance: {
    managedFields: [
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
    ],
  },
}),
```

## Managed fields are server-assigned — never send them

A field with a `nowMicroseconds` or `authUid` strategy is stamped by the apply function. The write API
**rejects** a client write payload that _includes_ a managed field, and the create-validation schema
**omits** managed-on-create fields. So: do not put `updated_at_us` or the owner column in a client
`create`/`update` payload; let the server assign them. (Both rules exist because the apply function
independently stamps these, so a client value would either be overwritten or rejected.)

## Read-path filtering: `customWhere` runs in Electric, not Postgres

A table's `shape.rowFilter` builds the Electric `where`. **Electric** evaluates it, so it filters on the
**literal** `claims.sub` (escape with `escapeSqlLiteral`), and any **enum column must be cast to text** —
`"role"::text = 'manager'`, not `"role" = 'manager'`. The column stays an enum everywhere else.

## RLS: derive read and write from one predicate

Authorization runs in two engines (Postgres RLS for writes; the Electric `where` for reads). Derive both
from the same predicate so a row can never be readable-but-unwritable (or the reverse):

- Common shapes: `buildSupabaseOwnerOrAdminNativePolicies` and `buildSupabaseMembershipNativePolicies`
  (from `@pgxsinkit/contracts`).
- Beyond them (e.g. collaborative any-member writes): compose your own from `pgPolicy` + the exported
  predicate builders. Inline the predicate (e.g. an `EXISTS` over `current_setting('request.jwt.claims')`)
  rather than referencing a not-yet-created SQL function — `CREATE POLICY` needs the function to exist
  first. For "compare OLD vs NEW" rules (e.g. immutability of a column), RLS cannot help (`WITH CHECK`
  sees only NEW, `USING` only OLD) — use a `BEFORE UPDATE` trigger.

## Provision the apply function from the registry

The write path applies through one in-database PL/pgSQL function, `pgxsinkit_apply_mutations`. Generate
the drizzle-kit migration that installs it with the published `pgxsinkit-generate` CLI (a `bin` of
`@pgxsinkit/server`), run from your project, then apply it through your normal migration flow:

```bash
bun run pgxsinkit-generate --registry ./sync-registry.ts --export registry \
  --project-dir ./db --config drizzle.config.ts --name sync_artifact
```

## Common mistakes

- Omitting `conflictPolicy` or the server-version field on a `readwrite` table (throws).
- Putting a managed field (`updated_at_us`, owner) in a client write payload (rejected).
- Comparing an enum without `::text`, or filtering on a non-literal subject, in a `rowFilter`.
- Letting the read filter and RLS policy diverge instead of deriving both from one predicate.
- Referencing a custom SQL function in `CREATE POLICY` before it exists (inline the predicate instead).

For the surrounding model (two paths, one write path, fail-closed subquery flag), load the `core` skill
from `@pgxsinkit/client`. Full prose: <https://pgxsinkit.github.io/start/getting-started/>.
