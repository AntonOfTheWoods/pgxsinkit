-- Cross-team move is Admin-only (board ADR-0005). An RLS UPDATE policy cannot compare OLD.team_id to
-- NEW.team_id (USING sees only the old row, WITH CHECK only the new), so a BEFORE UPDATE trigger
-- enforces it. The Admin check is the same inline predicate the RLS policies use — reading
-- request.jwt.claims, which the Mutation applier sets before applying a batch. Server authority,
-- never local (the Parity boundary).
CREATE OR REPLACE FUNCTION board_block_cross_team_move() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.team_id IS DISTINCT FROM OLD.team_id
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(
         coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'roles', '[]'::jsonb)
       ) AS r(role)
       WHERE r.role = 'admin'
     )
  THEN
    RAISE EXCEPTION 'cross-team move requires admin' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER issue_block_cross_team_move
  BEFORE UPDATE ON issue
  FOR EACH ROW EXECUTE FUNCTION board_block_cross_team_move();
