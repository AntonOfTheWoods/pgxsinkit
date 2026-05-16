# Sync Function Artifacts

This document defines how to manage SQL artifacts required by WRITE_API_BACKEND=bulk-plpgsql-artifact.

## Required function

1. Function name: public.pgxsinkit_apply_batch_mutations
2. Signature: (jsonb, text, boolean, boolean, jsonb)
3. Purpose: apply full batch payload inside PostgreSQL using one entry function, with optional RLS auth context propagation.

## RLS contract for artifact mode

1. When any registry table enables governance RLS, the artifact backend expects validated JWT claims from the server runtime.
2. The write API must provide claims through createSyncServer resolveAuthClaims so the batch function can validate them.
3. If RLS is enabled and claims are missing/invalid, POST /api/mutations returns 401.
4. The write API enriches batch payloads with ownership/audit fields only when the target table declares those columns, avoiding invalid-column writes for unrelated tables.

## Artifact location

1. Generated sync-function migration:
   - infra/drizzle/\*\_sync_artifact/migration.sql
2. Source inputs:
   - packages/schema/src/registry.ts
   - packages/server/src/mutations/bulk/plpgsql-strategy.ts

## Commands

1. Generate artifact SQL from current registry and strategy:
   - bun run sync:function:generate
   - This creates a custom migration under infra/drizzle/.
2. Generate governance migration SQL when DEFERRABLE constraints or conditional grants change:
   - bun run db:generate:governance
   - Commit the generated infra/drizzle/\*\_registry_governance migration alongside the schema/registry change.
3. Ensure the latest committed schema, governance, and sync-function migrations have already been applied before starting artifact mode:
   - bun run db:migrate

## Update workflow

1. Modify registry or mutation strategy.
2. Regenerate artifact SQL.
3. Generate a governance migration too if registry governance changed.
4. Commit the regenerated artifact and any new governance migration in the same PR as code changes.
5. Apply migrations in target environment.
6. Deploy write-api in bulk-plpgsql-artifact mode.

## Promotion expectations

1. Staging and prod should use the same artifact backend mode before promotion.
2. Do not rely on startup runtime generation for artifact mode.
3. Treat artifact SQL as deployable infrastructure code.

## Failure modes

1. Missing function:
   - Symptom: write-api startup fails verification for bulk-plpgsql-artifact.
   - Resolution: apply the latest committed migrations, then restart the service.
2. Missing governance auth helpers:
   - Symptom: POST /api/mutations returns a clear 500 about missing auth.uid/auth.jwt.
   - Resolution: ensure the environment bootstrap provides Supabase-compatible auth helpers, then retry the request.
3. Drift between code and artifact:
   - Symptom: behavior mismatch after deployment.
   - Resolution: regenerate the sync-function migration, apply the latest migrations, and rerun contract tests.
4. Deferred constraints not effective:
   - Symptom: FK violations despite artifact backend.
   - Resolution: ensure relevant FKs are declared DEFERRABLE in migrations.
