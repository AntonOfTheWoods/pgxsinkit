ALTER TABLE "workspace_members" ADD COLUMN "muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER POLICY "work_items_insert_membership" ON "work_items" TO "authenticated" WITH CHECK (((owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid) AND workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  )) AND ((workspace_id IN (
    SELECT id
    FROM workspaces
    WHERE locked = false
  )) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  )) AND workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND muted = false
  ));--> statement-breakpoint
ALTER POLICY "work_items_update_membership" ON "work_items" TO "authenticated" USING (((owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  )) AND ((workspace_id IN (
    SELECT id
    FROM workspaces
    WHERE locked = false
  )) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  )) AND workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND muted = false
  )) WITH CHECK (((owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  )) AND ((workspace_id IN (
    SELECT id
    FROM workspaces
    WHERE locked = false
  )) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  )) AND workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND muted = false
  ));