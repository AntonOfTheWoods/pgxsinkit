ALTER TABLE "authors" ALTER COLUMN "created_at_us" SET DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT);--> statement-breakpoint
ALTER TABLE "authors" ALTER COLUMN "updated_at_us" SET DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT);--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "created_at_us" SET DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT);--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "updated_at_us" SET DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT);--> statement-breakpoint
ALTER TABLE "operations_log" ALTER COLUMN "server_timestamp_us" SET DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT);