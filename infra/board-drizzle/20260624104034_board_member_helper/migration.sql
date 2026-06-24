-- Recursion-free membership helper (board ADR-0005).
--
-- Every board RLS membership predicate needs "the Teams the caller belongs to" — a read of
-- `team_member`. Inlining that read into `team_member`'s OWN policy (and into the issue/message
-- policies that also read team_member) makes Postgres re-enter team_member's RLS while it is still
-- evaluating it: `ERROR 42P17 infinite recursion detected in policy for relation "team_member"`.
-- That left the write path (apply runs `SET ROLE authenticated`) unable to apply any governed
-- mutation. (The read path never hit it: Electric connects as a BYPASSRLS superuser and the proxy
-- does the scoping, so RLS is not evaluated there.)
--
-- SECURITY DEFINER runs this as the function owner (the migration runs as `postgres`, a BYPASSRLS
-- superuser), so the `team_member` read does NOT re-trigger RLS — the recursion is broken at the
-- source, and every predicate that routes through this helper inherits the fix. `auth.uid()` still
-- resolves the *caller's* `sub`: `current_setting` is session state, unaffected by SECURITY DEFINER.
-- STABLE (pure within a statement) + a pinned `search_path` (the SECURITY DEFINER hardening rule).
CREATE OR REPLACE FUNCTION board_member_team_ids() RETURNS SETOF uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT team_id FROM team_member WHERE user_id = auth.uid();
$$;