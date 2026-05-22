create table if not exists public.firsttrace_jobs (
  id uuid primary key,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  ai_enabled boolean not null default false,
  attempts integer not null default 0,
  max_attempts integer not null default 1,
  config_path text not null,
  report text not null,
  source jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists firsttrace_jobs_claim_idx
  on public.firsttrace_jobs (status, created_at, id)
  where status = 'queued';

alter table public.firsttrace_jobs enable row level security;

grant select, insert, update, delete on public.firsttrace_jobs to service_role;

create or replace function public.firsttrace_claim_next_job()
returns public.firsttrace_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.firsttrace_jobs;
begin
  update public.firsttrace_jobs
  set
    attempts = attempts + 1,
    error = null,
    started_at = now(),
    status = 'running',
    updated_at = now()
  where id = (
    select id
    from public.firsttrace_jobs
    where status = 'queued'
      and attempts < max_attempts
    order by created_at asc, id asc
    for update skip locked
    limit 1
  )
  returning * into claimed;

  return claimed;
end;
$$;

grant execute on function public.firsttrace_claim_next_job() to service_role;
