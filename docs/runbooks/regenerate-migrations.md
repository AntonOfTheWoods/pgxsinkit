# Runbook: regenerate the demo & integration migrations

## When to use

Whenever the demo or integration **schema** (`packages/schema`, `packages/board-schema`, the
operations-log schema) or the **sync registry** changes, regenerate the affected migrations so the
committed `infra/drizzle/` and `infra/board-drizzle/` histories match the current sources. Also use it,
while pre-launch, to collapse churn (e.g. several redundant `*_sync_artifact` folders) into one.

**This is entirely the agent's job. There is no operator/maintainer step — see
[Nothing for the maintainer](#nothing-for-the-maintainer--ever) at the end.** Unlike a product app with
a long-living personal dev/smoke database, pgxsinkit has **no persistent database at all**: every
database these migrations target is **ephemeral** — the demo stacks and the integration/perf harness
create a fresh Postgres and apply the whole committed history on each start/run.

## How the migration framework works here

- `drizzle-kit` 1.0+ emits one folder per migration (`migration.sql` + `snapshot.json`). There is **no
  central `meta/_journal.json`** — ordering is the timestamped folder prefix, and applied state is
  tracked in the `drizzle.__drizzle_migrations` table of whatever ephemeral DB is currently running.
- Two databases, two committed histories:
  - **`infra/drizzle/`** — the reference write-api and the integration/perf harness (`packages/schema`).
  - **`infra/board-drizzle/`** — the board demo (`packages/board-schema`).
- Each history mixes **generated** migrations (re-emit them on change) with **hand-written** custom
  migrations (no generator — leave them in place across a regen):

  | set                   | generated (re-emit on change)                                                                     | hand-written (preserved as-is)                                          |
  | --------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
  | `infra/drizzle`       | schema (`db:generate`), governance (`db:generate:governance`), sync-fn (`sync:function:generate`) | —                                                                       |
  | `infra/board-drizzle` | schema (`db:board:generate`), sync-fn (`db:board:sync-fn`)                                        | `*_board_cross_team_trigger`, `*_board_grants`, `*_board_member_helper` |

  `db:generate` / `db:board:generate` diff the Drizzle schema against the latest `snapshot.json` on disk
  — they **never read a database**. The sync-fn generators (ADR-0018) stamp the apply function with a
  fingerprint of its own DDL; `sync:function:check` (run in CI and the server at startup) fails if a
  committed migration ever lags its registry.

## Procedure (all of it is the agent's; none of it needs a database)

Run from the repo root. Every step here is **filesystem-only** — nothing reads or writes a server DB.

1. **Edit the schema / registry sources.**
2. **Regenerate the affected migration(s):**
   - `infra/drizzle` schema change: `bun run db:generate` (and `bun run db:generate:governance` if
     typed governance metadata — DEFERRABLE constraints, conditional grants — changed)
   - `infra/drizzle` registry / apply-function change: `bun run sync:function:generate`
   - board schema change: `bun run db:board:generate`
   - board registry / apply-function change: `bun run db:board:sync-fn`

   The hand-written board customs have no generator — do not delete or regenerate them.

3. **Format, validate, drift-check:**
   ```bash
   bun run format:write           # drizzle emits snapshot.json in its own style; oxfmt owns formatting
   bun run validate               # filesystem-only: PGlite-backed unit tests, never a server DB
   bun run sync:function:check    # asserts the committed sync-fn migrations match the registries
   ```
4. **Commit** the regenerated migration folders in the same changeset as the source edit.

To collapse pre-launch churn (e.g. redundant `*_sync_artifact` folders), delete the stale **generated**
folders, run the matching generator once, then steps 3–4. The apply-function migration is a standalone
`DROP … ; CREATE OR REPLACE`, so a single fresh one ordered after the schema migrations is sufficient.

## Nothing for the maintainer — ever

> These migrations only ever target **ephemeral** databases — the demo stacks and the integration/perf
> harness, recreated from scratch on every run. There is **no long-living pgxsinkit dev/smoke database**,
> so the "operator applies the migrations to their personal DB" step that exists for a product app
> **does not exist here**. The maintainer does **nothing**, and the agent must not imply otherwise.
>
> - The new history applies **automatically** the next time anything starts: every `bun run infra:up`
>   (board), `bun run infra:harness:up` (reference), and every integration/perf run brings up a fresh
>   Postgres and applies the **whole committed history**. There is nothing to apply by hand and nobody
>   to wait for.
> - **Never tell the maintainer to apply, migrate, reset, or "bring a database in line."** There is no
>   such database.
> - The **only** follow-up is optional and the **agent's own**: if a stack is **already running** and
>   should reflect the change immediately, the agent cycles it — `bun run infra:down && bun run infra:up`
>   (board) or `bun run infra:harness:down && bun run infra:harness:up` (reference). **If nothing is
>   running, there is nothing to do** — do not mention an apply step at all; saying so when no stack is
>   up is just confusing.
