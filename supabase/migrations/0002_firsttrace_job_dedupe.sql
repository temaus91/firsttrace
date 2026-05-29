alter table public.firsttrace_jobs
  add column if not exists dedupe_key text;

create unique index if not exists firsttrace_jobs_dedupe_key_idx
  on public.firsttrace_jobs (dedupe_key)
  where dedupe_key is not null;
