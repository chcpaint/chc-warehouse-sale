-- 004_token_status_rls.sql
-- Security: token_status had RLS disabled, leaving it readable/writable by the anon key.
-- The app uses the service-role client only (which bypasses RLS) and no code references
-- this table, so enabling RLS with no permissive policy closes anon/authenticated access
-- without affecting the application.

ALTER TABLE public.token_status ENABLE ROW LEVEL SECURITY;
