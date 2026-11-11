-- ============================================================================
-- 062_ai_usage_log.sql
--
-- One row for every call the software makes to an AI model: Insights and
-- price-screenshot reading (utils/ai-usage.js lists every feature). Lets CHC
-- report exactly when AI was used, by whom, for which customer, with which
-- model, what was sent and what came back.
--
-- Closed to the public API like every other table (row security on, no
-- policy); only the server writes and reads it. Safe to run twice.
-- ============================================================================
create table if not exists public.ai_usage_log (
    id             uuid primary key default gen_random_uuid(),
    created_at     timestamptz not null default now(),
    feature        text not null check (feature in ('insights', 'price_screenshot')),
    company_id     uuid references public.companies(id) on delete set null,
    distributor_id uuid,
    location_id    uuid references public.company_locations(id) on delete set null,
    actor_type     text,
    actor_id       uuid,
    provider       text not null default 'anthropic',
    model          text,
    status         text not null default 'ok',
    error_code     text,
    input_tokens   integer,
    output_tokens  integer,
    latency_ms     integer,
    request_id     text,
    input_summary  jsonb,
    output         jsonb
);

create index if not exists idx_ai_usage_log_company_time on public.ai_usage_log (company_id, created_at desc);
create index if not exists idx_ai_usage_log_time on public.ai_usage_log (created_at desc);
create index if not exists idx_fk_ai_usage_log_location on public.ai_usage_log (location_id);

alter table public.ai_usage_log enable row level security;

select 'ai_usage_log ready' as status, count(*) as rows from public.ai_usage_log;
