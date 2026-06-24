<p align="center">
  <a href="https://pgxsinkit.github.io">
    <picture>
      <source srcset="./brand/banner/banner.avif" type="image/avif" />
      <source srcset="./brand/banner/banner.webp" type="image/webp" />
      <img src="./brand/banner/banner.png" alt="pgxsinkit" width="720" />
    </picture>
  </a>
</p>

# pgxsinkit

`pgxsinkit` is an offline-first **sync toolkit** for a `PostgreSQL -> ElectricSQL -> PGlite` read path and a `client -> write API -> PostgreSQL` write path. The `@pgxsinkit/*` packages are the product; the demo app (`apps/board`), the minimal reference server (`apps/write-api`), and the integration + performance harness exist to prove and harden them. See [CONTEXT.md](./CONTEXT.md) for the canonical vocabulary.

Canonical timestamps are stored as bigint microseconds since unix epoch and cross API/sync boundaries as decimal strings.

## Requirements

`pgxsinkit` row filters may use cross-table subquery `where` clauses — for example membership
fan-out, where a row in a container streams to every member of that container:

```sql
container_id IN (SELECT container_id FROM memberships WHERE member_id = <subject>)
```

The electric-proxy forwards this verbatim as the Electric shape `where`, so streaming it relies on
a **required** ElectricSQL capability:

- **ElectricSQL >= 1.6** running with `ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries`.

This is a hard prerequisite of using pgxsinkit, not an optional optimisation. Subquery `where`
support is a flagged preview feature (still flagged as of 1.7.2); without the flag Electric rejects
any subquery `where` with HTTP 400 (`{"where":["Subqueries are not supported"]}`). The sync then
fails **closed** — no rows stream — it never silently fans out unfiltered data. `infra/compose`
pins `electricsql/electric:1.7.2` and sets the flag; any deployment consuming pgxsinkit must do the
same.

A second point follows from the same grammar: **a PostgreSQL `enum` column referenced in a shape
`where` must be cast to `text`** — `"role"::text = 'manager'`, not `"role" = 'manager'`. Electric's
where-grammar does not accept a bare enum comparison (`invalid syntax for type enum …`) nor a literal
cast to the enum (`unsupported type …`); casting the _column_ to text is the supported form (per the
[Electric shapes docs](https://electric.ax/docs/sync/guides/shapes): enums are allowed "when
explicitly casting them to text"). The enum column itself stays an enum — RLS and the write path keep
using it natively, so there is no enum→text migration (which would in any case fail while an RLS
policy depends on the column).

## Goals

- Own the downward read-path ingest end-to-end (ADR-0009): we still sync with Electric (`@electric-sql/client` + `@electric-sql/experimental`), but the ingest engine is an internal module of `@pgxsinkit/client`, not a separate vendored package.
- Put the write path behind a typed API using Bun, Drizzle, and Zod.
- Maintain fast unit tests plus container-backed integration tests.
- Make upgrades of Drizzle, PostgreSQL, ElectricSQL, and PGlite routine and measurable.

## Workspace layout

- `apps/board`: the substantial demo — a Linear-style board + chat (React + Vite + Mantine, local PGlite) on a partial Supabase + Electric stack. Replaced the old generic `apps/web`.
- `apps/write-api`: the minimal `@pgxsinkit/server` reference (Bun + Hono).
- `packages/contracts`: shared validation schemas, registry definitions, and DTOs.
- `packages/client`: offline client — local store, mutation runtime, and the internalized read-path sync engine (`src/sync/`, ADR-0009).
- `packages/server`: the runtime-portable write API + Electric shape proxy (`createSyncServer`).
- `packages/react`: React bindings (`createSyncClientHooks`).
- `packages/schema`: the harness/reference demo registry (membership fixture).
- `packages/board-schema`: the board demo's registry + hand-authored RLS.
- `supabase/functions`: the board's Deno edge functions (`board-write` / `board-sync`); bundled by `bun run edge:build`.
- `infra/compose`: compose files — `docker-compose.yml` (harness) and `board-compose.yml` (the board's partial Supabase stack).
- `infra/drizzle`: harness drizzle migrations; `infra/board-drizzle`: the board's own migration history.
- `tests/unit`: pure unit tests; `tests/integration`: container-backed integration tests.

## Quick start

Run the **board demo** (the substantial example):

1. `mise install`
2. `bun install`
3. `cp .env.example .env`
4. `bun run infra:up` — brings up the full board stack (partial Supabase + Electric), builds the edge functions, and applies the board's drizzle migration history
5. `bun run seed:board` — GoTrue identities + fixtures
6. `bun run dev:board`

The board stack is self-contained on its own ports (gateway `54331`, db `54322`, electric `54330`), so it coexists with the harness. Studio is at `http://localhost:54333`.

For the **minimal reference server** (`apps/write-api`) instead, use the harness stack: `bun run infra:harness:up` (PostgreSQL + Electric + the committed `infra/drizzle` history) → `bun run dev:api`. Integration and perf lanes stand up their own isolated stacks and depend on neither.

## Releasing

See [RELEASING.md](./RELEASING.md) for publishing the `@pgxsinkit/*` packages to npm and GitHub Packages. Push a semver **tag**; CI derives the version from the tag and publishes all packages at that one version — there is no version bump (see [adr/0001](docs/adr/0001-unified-ts-release-versioning-tooling-standard.md)).

## Provisioning workflow

1. Edit schema sources in `packages/schema/src/schema.ts`, `packages/schema/src/integration.ts`, and/or `packages/server/src/operations-log/schema.ts`.
2. Generate schema migrations: `bun run db:generate`.
3. Generate governance SQL when needed: `bun run db:generate:governance`.
4. Regenerate sync function artifact when registry/strategy changes: `bun run sync:function:generate`.
5. Review generated SQL under `infra/drizzle/`.
6. Apply the committed migration history: `bun run db:migrate` (or `bun run infra:harness:up`). The board's own history applies via `bun run db:board:migrate` (or `bun run infra:up`).
7. Commit governance and sync-function migrations alongside the related code changes; there is no separate apply step for them.

See `docs/migrations.md` and `docs/function-artifacts.md`.

## Integration test model

- `bun run test:integration:contract`
- `bun run test:integration:implementation`
- `bun run test:integration`

These spin up isolated compose stacks on ephemeral ports and tear everything down afterward.

## Perf lab

`bun run perf:lab` now owns a dedicated fixed-name stack separate from the shared demo workflow. It tears down any prior `pgxsinkit-perf-lab` containers and child processes, starts fresh PostgreSQL, ElectricSQL, a dedicated perf-lab write server, and the browser lab, then writes logs under `tmp/perf-lab/`.

The browser default is the full cycle: seed PostgreSQL for the active synthetic registry, sync those rows into browser PGlite, flush local mutations upstream, and wait for the Electric echo to clear overlay state again.

## Performance suites

Long-running performance tests are intentionally separate from `bun run validate`.

Commands:

- `bun run test:performance`
- `bun run test:performance:client`
- `bun run test:performance:concurrent`
- `bun run test:performance:concurrent:matrix`
- `bun run test:performance:server`

The concurrent lane reads configuration from `PGXSINKIT_PERF_*` environment variables. For the common case, yes: prefixing the variable before the Bun command is enough.

Examples:

- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE=multi-process bun run test:performance:concurrent`
- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE=multi-process PGXSINKIT_PERF_PRESET=smoke PGXSINKIT_PERF_SCENARIO_KEY=mixed-small-bursts bun run test:performance:concurrent`

Execution mode options:

- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE=single-process`
- `PGXSINKIT_PERF_CONCURRENT_EXEC_MODE=multi-process`

If unset, the concurrent suite defaults to `single-process`.

Preset and scenario selection:

- `PGXSINKIT_PERF_PRESET=smoke|realistic|heavy`
- `PGXSINKIT_PERF_SCENARIO_KEY=mixed-small-bursts|mixed-small-plus-large|hot-partition-overlap`

The performance runner provisions its own isolated PostgreSQL and ElectricSQL stack, applies the current Drizzle schema, runs the requested perf tests, writes JSON reports under `tmp/perf-results/`, and tears the stack down afterward.

More detailed performance configuration, including the full env var list and matrix runner options, lives in `tests/performance/README.md`.

## The write path

There is exactly one write path: client writes are staged locally, flushed through the write API,
and applied to PostgreSQL in a single in-database PL/pgSQL function (`pgxsinkit_apply_mutations`).
There is no selectable backend — the in-database bulk apply is the only strategy (see
[docs/adr/0002](./docs/adr/0002-single-in-database-write-path.md)).

Long-polling shape proxy requests may need a higher Bun idle timeout than the default 10 seconds (the `apps/write-api` reference):

- `WRITE_API_IDLE_TIMEOUT_SECONDS=120`

On the board, the equivalent concern is the edge functions' wall-clock; `board-sync` is given an idle window above Electric's ~25s long-poll so live updates are not cut off (board ADR-0001).

## Auth

Two demonstrations of the single `resolveAuthClaims` adapter both ingress paths share:

- **Reference (`apps/write-api`)** — an end-to-end auth simulation with no external identity provider: fixed Supabase-style HS256 JWTs for `user` / `admin`, sent as `Authorization: Bearer …` on write and shape requests. The write API validates them into `resolveAuthClaims` and exposes `/v1/electric-proxy`, enforcing owner filters for protected tables unless the caller is `admin`. If `DEMO_JWT_SECRET` is unset, the shared demo secret is used.
- **Board (`apps/board`)** — real **GoTrue** auth: identities are seeded through the GoTrue admin API and signed in with `signInWithPassword`; the edge functions verify the real access token (HS256, the project `JWT_SECRET`) in `resolveAuthClaims`. See [start/deploying-the-server](apps/docs/src/content/docs/start/deploying-the-server.md).

## Operations logging

Server-side operations logging is startup-configured with:

- `WRITE_API_OPS_LOG_ENABLED=true` (default)
- `WRITE_API_OPS_LOG_ENABLED=false`

The `operations_log` table is migration-managed (not runtime-created).

## Validation

Typical gates:

- `bun run validate` # fast pre-commit gate: format, lint, typecheck, fast unit subset
- `bun run validate:full` # pre-push + CI gate: adds the PGlite-backed unit suite
- `bun run test:integration:contract`
- `bun run test:integration:implementation`

## Version policy

- Type checking uses the native preview compiler (`bun run typecheck`).

## References

- `docs/architecture.md`
- `docs/testing-strategy.md`
- `docs/ai-assistant-guide.md`
