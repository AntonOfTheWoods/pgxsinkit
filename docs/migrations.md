# Migration Workflow

This document defines the canonical path from Drizzle table definitions to provisioned dev, staging, and prod databases with sync-ready support functions.

## Ownership model

1. Drizzle schema files own relational structures (tables, columns, indexes):
   - packages/schema/src/schema.ts
   - packages/schema/src/integration.ts
   - packages/server/src/operations-log/schema.ts
2. Drizzle migration SQL in infra/drizzle/ is the deployable history for schema changes.
3. Governance-only PostgreSQL changes that Drizzle schema generation does not emit directly, such as DEFERRABLE constraints and conditional table grants, are generated from typed registry metadata and committed into the same infra/drizzle/ history.
4. Sync support functions for bulk-plpgsql-artifact are SQL artifacts generated from the registry and committed to infra/sql/functions/.
5. Runtime startup checks in the write API verify prerequisites, but are not the primary deployment mechanism for staging/prod.

## End-to-end workflow

1. Edit schema sources.
2. Generate migration SQL.
   - Command: bun run db:generate
3. Generate governance migration SQL from typed registry metadata when needed.
   - Command: bun run db:generate:governance
   - Use this when changing typed governance metadata such as DEFERRABLE constraints or conditional grants.
4. Review generated migration SQL under infra/drizzle/.
5. Regenerate sync function artifacts when registry or mutation strategy changes.
   - Command: bun run sync:function:generate
   - This writes a custom sync-function migration into infra/drizzle/.
6. Commit schema files, migration SQL, registry metadata changes, and function artifacts in one changeset.
7. Apply migrations to target database.
   - Dev/local: bun run db:migrate
   - Staging/prod: apply the same committed infra/drizzle/ history via your deployment runner.
8. Ensure the latest committed governance migration has been applied when governance metadata changed.
   - This uses the same bun run db:migrate path because governance migrations are committed into infra/drizzle/.
9. Ensure the latest committed sync-function migration has been applied when the artifact function changes.
   - This also uses the same bun run db:migrate path because sync-function DDL is committed into infra/drizzle/.
10. Start write-api with backend matching provisioned state.
    - Example: WRITE_API_BACKEND=bulk-plpgsql-artifact bun run dev:api
11. If governance RLS is enabled for any registry table, provide validated JWT claims to createSyncServer via resolveAuthClaims.
12. Expect POST /api/mutations to return 401 in artifact mode when RLS is enabled but claims are missing.
13. Expect POST /api/mutations to return a clear 500 about missing auth helpers when the environment bootstrap is incomplete.
14. Run validation and integration checks.
    - Commands:
      - bun run validate
      - bun run format:check
      - bun run lint:check
      - bun run typecheck
      - bun run test:integration:contract
      - bun run test:integration:implementation

## Current auth and ownership migrations

1. The ownership/audit rollout is represented in schema migrations with:
   - owner_id and modified_by on authors and todos
   - user_id and index on operations_log
2. Governance migration generation now emits:
   - DEFERRABLE constraint alterations from typed registry governance metadata
   - conditional grants for roles such as authenticated when table governance requires them
3. Native RLS policies for demo and integration tables are emitted by the normal Drizzle schema migration path.
4. Supabase-compatible auth helpers are expected to come from the environment bootstrap in local/dev and from the target platform in staging/prod.

## Environment rollout contract

1. Dev:
   - Use bun run infra:up to bootstrap infra and apply the latest committed infra/drizzle/ history.
   - Prefer bulk-plpgsql for iteration speed, or bulk-plpgsql-artifact when validating prod parity.
2. Staging:
   - Apply the exact migration set intended for prod.
   - Ensure the latest committed sync-function migration is included if staging uses artifact backend.
   - Run contract integration suite before promotion.
3. Prod:
   - Apply migrations first.
   - Ensure the latest committed sync-function migration is included.
   - Deploy write-api with WRITE_API_BACKEND=bulk-plpgsql-artifact.
   - Keep staging and prod backend modes aligned.

## Deferred constraint requirement

1. The artifact backend transaction path executes SET CONSTRAINTS ALL DEFERRED.
2. This only affects constraints declared DEFERRABLE in PostgreSQL.
3. DEFERRABLE FK alterations such as todos->authors are generated from typed registry governance metadata via bun run db:generate:governance and committed into infra/drizzle/\*\_registry_governance/migration.sql.

## Supabase-compatible auth helpers

1. Governance migration generation does not currently emit auth helper SQL.
2. The artifact batch function validates claims when p_rls_enabled=true.
3. Missing auth.uid()/auth.jwt() behavior indicates incomplete environment bootstrap, not a missing separate governance-apply step.

## Proof coverage

1. Integration test coverage now includes out-of-order parent/child batch writes in:
   - tests/integration/write-api.integration.test.ts
2. Expected behavior is asserted for both backends:
   - bulk-plpgsql: fails and rolls back with immediate constraint checks.
   - bulk-plpgsql-artifact: succeeds with deferred checks under DEFERRABLE FK.

## Remaining implementation steps

1. Add CI checks to fail when function artifacts are stale relative to registry/strategy changes.
2. Add a release runbook for rollback behavior after partial deployment failures.
