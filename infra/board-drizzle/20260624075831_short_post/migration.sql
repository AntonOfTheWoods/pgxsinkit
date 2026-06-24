CREATE TYPE "channel_kind" AS ENUM('global', 'team');--> statement-breakpoint
CREATE TYPE "issue_priority" AS ENUM('none', 'urgent', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "issue_status" AS ENUM('backlog', 'todo', 'in_progress', 'done');--> statement-breakpoint
CREATE TABLE "channel" (
	"id" uuid PRIMARY KEY,
	"team_id" uuid,
	"kind" "channel_kind" NOT NULL,
	"name" varchar(120) NOT NULL,
	"created_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue" (
	"id" uuid PRIMARY KEY,
	"team_id" uuid NOT NULL,
	"assignee_id" uuid,
	"title" varchar(200) NOT NULL,
	"description" varchar(4000),
	"status" "issue_status" DEFAULT 'todo'::"issue_status" NOT NULL,
	"priority" "issue_priority" DEFAULT 'none'::"issue_priority" NOT NULL,
	"created_by" uuid,
	"created_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL,
	"updated_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY,
	"channel_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" varchar(4000) NOT NULL,
	"created_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL,
	"updated_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profile" (
	"id" uuid PRIMARY KEY,
	"display_name" varchar(120) NOT NULL,
	"avatar_color" varchar(24) DEFAULT 'indigo' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_member" (
	"id" uuid PRIMARY KEY,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL,
	"updated_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY,
	"name" varchar(120) NOT NULL,
	"created_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id");--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id");--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_assignee_id_profile_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "profile"("id");--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_created_by_profile_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profile"("id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_channel_id_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel"("id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_id_profile_id_fkey" FOREIGN KEY ("author_id") REFERENCES "profile"("id");--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id");--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_user_id_profile_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profile"("id");--> statement-breakpoint
CREATE POLICY "issue_select" ON "issue" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((team_id IN (SELECT team_id FROM team_member WHERE user_id = auth.uid())) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));--> statement-breakpoint
CREATE POLICY "issue_insert" ON "issue" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((team_id IN (SELECT team_id FROM team_member WHERE user_id = auth.uid())) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));--> statement-breakpoint
CREATE POLICY "issue_update" ON "issue" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((team_id IN (SELECT team_id FROM team_member WHERE user_id = auth.uid())) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin')) WITH CHECK ((team_id IN (SELECT team_id FROM team_member WHERE user_id = auth.uid())) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));--> statement-breakpoint
CREATE POLICY "issue_delete" ON "issue" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((team_id IN (SELECT team_id FROM team_member WHERE user_id = auth.uid())) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));--> statement-breakpoint
CREATE POLICY "message_select" ON "message" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((channel_id IN (SELECT id FROM channel WHERE kind = 'global' OR team_id IN (SELECT team_id FROM team_member WHERE user_id = auth.uid()))) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));--> statement-breakpoint
CREATE POLICY "message_insert" ON "message" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((channel_id IN (SELECT id FROM channel WHERE kind = 'global' OR team_id IN (SELECT team_id FROM team_member WHERE user_id = auth.uid()))) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));--> statement-breakpoint
CREATE POLICY "message_update" ON "message" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (author_id = auth.uid() OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin')) WITH CHECK (author_id = auth.uid() OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));--> statement-breakpoint
CREATE POLICY "message_delete" ON "message" AS PERMISSIVE FOR DELETE TO "authenticated" USING (author_id = auth.uid() OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));--> statement-breakpoint
CREATE POLICY "team_member_select" ON "team_member" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((team_id IN (SELECT team_id FROM team_member WHERE user_id = auth.uid())) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));--> statement-breakpoint
CREATE POLICY "team_member_insert" ON "team_member" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));--> statement-breakpoint
CREATE POLICY "team_member_update" ON "team_member" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin')) WITH CHECK (EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));--> statement-breakpoint
CREATE POLICY "team_member_delete" ON "team_member" AS PERMISSIVE FOR DELETE TO "authenticated" USING (EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS r(role) WHERE r.role = 'admin'));