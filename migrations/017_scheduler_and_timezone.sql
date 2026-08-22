-- 017 — the scheduler, and the time zone it needs to be useful.
--
-- The low-stock digest and the reorder notice were both built and both waiting
-- for something to call them. This adds that something, and the two pieces of
-- state it needs: where a company is in the world, and which scheduled runs
-- have already happened.

-- Digests should arrive in the morning where the SHOP is. Railway runs UTC, so
-- a fixed UTC hour drifts an hour twice a year against every Canadian customer.
alter table public.companies
    add column if not exists timezone text;

comment on column public.companies.timezone is
    'IANA zone (e.g. America/Toronto) used to decide the local hour a scheduled email goes out. NULL falls back to America/Toronto.';

update public.companies set timezone = 'America/Toronto' where timezone is null;

-- ------------------------------------------------------------
-- The claim table
--
-- This is the whole of the distributed lock. Several app instances may decide
-- at the same moment that a job is due; each tries to insert the same
-- (job, run_key) and the unique constraint means exactly one succeeds. No
-- Redis, no leader election, no extra service — just a constraint the database
-- already enforces perfectly.
-- ------------------------------------------------------------
create table if not exists public.scheduler_runs (
    id          uuid primary key default gen_random_uuid(),
    job         text not null,
    run_key     text not null,
    detail      jsonb,
    result      jsonb,
    started_at  timestamptz not null default now(),
    finished_at timestamptz,

    constraint scheduler_runs_unique unique (job, run_key)
);

comment on table public.scheduler_runs is
    'One row per scheduled job execution. The unique (job, run_key) is the lock: whichever app instance inserts first is the one that runs the job.';
comment on column public.scheduler_runs.run_key is
    'What makes this execution distinct — typically job:company:local-date, so a job runs once per company per local day.';
comment on column public.scheduler_runs.finished_at is
    'NULL means claimed but never completed: the instance died mid-job. Useful for spotting that; the job will not retry until the next run key.';

create index if not exists idx_scheduler_runs_job_started
    on public.scheduler_runs(job, started_at desc);

alter table public.scheduler_runs enable row level security;
revoke all on public.scheduler_runs from anon, authenticated;

-- ------------------------------------------------------------
-- Housekeeping: this table grows one row per company per day forever.
-- ------------------------------------------------------------
create or replace function public.prune_scheduler_runs(keep_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    removed integer;
begin
    delete from public.scheduler_runs
     where started_at < now() - make_interval(days => keep_days);
    get diagnostics removed = row_count;
    return removed;
end;
$$;

revoke all on function public.prune_scheduler_runs(integer) from public, anon, authenticated;

-- ------------------------------------------------------------
-- The alert log gains a type it did not have. No constraint gates alert_type,
-- so nothing to alter — but the index below matters: the suppression check
-- reads by (company, type, fingerprint, sent_at) on every reorder raised, which
-- is a hot path on a busy morning.
-- ------------------------------------------------------------
create index if not exists idx_inventory_alert_log_lookup
    on public.inventory_alert_log(company_id, alert_type, fingerprint, sent_at desc);
