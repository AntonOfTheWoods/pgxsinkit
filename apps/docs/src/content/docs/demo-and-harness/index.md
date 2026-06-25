---
title: Demo & harness
description: The demo app and verification suites exist to prove and harden the toolkit — they are not the product.
sidebar:
  label: Overview
---

The repository contains a demo app and a verification harness. Neither is the product — the
[`@pgxsinkit/*` packages](/packages/) are. These exist to make the toolkit demonstrable and to keep
it honest against real infrastructure.

## The demo app (`apps/board`)

`apps/board` is a Linear-style issue board with realtime chat — the **substantial** demo (it replaced
an earlier generic `apps/web`). It drives the full read and write paths against a trimmed, but
version-matched, self-hosted **Supabase + Electric** stack: GoTrue auth, a Kong gateway, the two
toolkit edge functions (`board-write` for the governed mutation ingress, `board-sync` for the
registry-filtered Electric shape proxy), Postgres, and Electric. Its job is twofold:

- **Example code for consumers** — a working reference for wiring `createSyncClient`, staging and
  flushing optimistic writes, reading reactively from PGlite, and surfacing convergence/conflict state.
- **A smoke-testing ground for maintainers** — somewhere to see offline-first sync, membership
  fan-out, optimistic writes, and conflict convergence working end-to-end, by hand.

It uses a Linear-style domain (Teams, Issues, Channels, Messages). It is one _consumer_ of pgxsinkit —
not pgxsinkit itself, and not any downstream product's data layer. Run it:

```bash
mise install && bun install
bun run infra:up      # the board stack (Supabase + Electric) + the board's migrations
bun run seed:board    # GoTrue identities + deterministic fixtures
bun run dev:board     # the Vite client
```

The board runs **unchanged against real cloud Supabase + Electric Cloud** — the endpoints are fully
env-driven (`SUPABASE_URL`/keys/`JWT_SECRET`/DB URL/`ELECTRIC_SHAPE_URL`); the local compose is just a
dev mirror.

The **minimal** reference (the `apps/write-api` Bun server) runs against the toolkit harness stack
instead — the smallest possible `@pgxsinkit/server` deployment:

```bash
cp .env.example .env
bun run infra:harness:up   # PostgreSQL + Electric reference stack (allow_subqueries,tagged_subqueries)
bun run dev:api            # the @pgxsinkit/server reference server
```

## The verification harness

The harness is where the toolkit earns trust. It runs against **real** services in Podman compose
stacks — not mocks.

- **Toolkit integration suites** (`tests/integration`) — prove the topology end-to-end in an
  **isolated, ephemeral** PostgreSQL + Electric stack (allocated ports, a unique project name, torn
  down after): write validation, the in-database apply, membership fan-out, RLS auth context, and
  eventual convergence in local PGlite.

  ```bash
  bun run test:integration:contract
  bun run test:integration:implementation
  bun run test:integration
  ```

- **Board demo smoke** (`bun run test:integration:board`) — drives the demo's **real deployment
  topology** rather than the in-process primitives: GoTrue login → Kong → the bundled `board-write` /
  `board-sync` edge functions → Electric, proving the governed path the other suites stub out (auth,
  the proxy's claim-driven `customWhere` read filter, and the apply's RLS actor switch). It owns the
  board stack — it brings it up, seeds the deterministic fixtures, runs the smoke, and tears it down —
  so it does not run alongside a dev board stack (pass `--keep` to leave it up after a failure).

  ```bash
  bun run test:integration:board
  ```

- **Performance lab** (`apps/perf-lab`, `tests/performance`) — measures the write/sync cycle under
  load; kept separate from `bun run validate`.

  ```bash
  bun run perf:lab
  bun run test:performance
  ```

Each lane provisions its own services, applies the current schema, runs, and tears everything down.
See the repository's `docs/testing-strategy.md` for the full model.
