-- 065_backup_runs.sql
--
-- A record of each nightly backup's restore drill, written by the GitHub
-- workflow (.github/workflows/backup.yml) after it has restored the night's
-- backup into a throwaway database and counted every row. The admin console
-- and the public Help page read it, so "backups are tested" is shown from
-- evidence, not stated.
--
-- Safe to run more than once. Touches no app data.

create table if not exists public.backup_runs (
  id           bigserial primary key,
  run_at       timestamptz not null default now(),
  status       text not null check (status in ('passed', 'failed')),
  tables       int,
  rows_checked bigint,
  files        int,
  bytes        bigint,
  run_url      text check (run_url is null or run_url ~ '^https://github\.com/'),
  note         varchar(500)
);
create index if not exists idx_backup_runs_time on public.backup_runs (run_at desc);

-- Server-only (service role); nothing public.
alter table public.backup_runs enable row level security;

-- Check:
--   select * from public.backup_runs order by run_at desc limit 5;
