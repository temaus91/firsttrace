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

  if claimed.id is null then
    return null;
  end if;

  return claimed;
end;
$$;

grant execute on function public.firsttrace_claim_next_job() to service_role;
