-- 011_console_visits.sql
-- Anonymous usage logging for the storefront (visit / login / enter-store).
CREATE TABLE IF NOT EXISTS public.console_visits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid,
  slug text,
  event text,
  location_id uuid,
  session_id text,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
CREATE INDEX IF NOT EXISTS idx_console_visits_company ON public.console_visits(company_id, created_at);
ALTER TABLE public.console_visits ENABLE ROW LEVEL SECURITY;
