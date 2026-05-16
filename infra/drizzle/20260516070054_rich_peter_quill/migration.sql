CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY,
	"name" varchar(120) NOT NULL,
	"scheduled_at" timestamp with time zone,
	"created_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL,
	"updated_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL
);
