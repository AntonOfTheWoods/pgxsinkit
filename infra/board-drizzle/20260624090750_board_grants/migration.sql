-- Board table grants to `authenticated` (the role the applier switches into per batch).
--
-- RLS is a filter ON TOP of table privileges: without a grant, `authenticated` gets "permission
-- denied for table …" before any policy is even consulted. So every table needs SELECT (the RLS
-- subqueries read team_member, and FK checks read the parent rows), and the writable tables need the
-- DML grants on top — RLS then decides which rows. The readonly tables (profile/team/channel) get
-- SELECT only, so they stay read-only for authenticated regardless of RLS. The seed and Electric
-- connect as supabase_admin (superuser), so they need none of this.
--
-- Mirrors the harness governance migration (infra/drizzle/.../registry_governance) for the board.

GRANT SELECT ON TABLE "profile", "team", "team_member", "channel", "issue", "message" TO "authenticated";
GRANT INSERT, UPDATE, DELETE ON TABLE "team_member", "issue", "message" TO "authenticated";
