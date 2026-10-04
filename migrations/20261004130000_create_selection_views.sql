create table if not exists public.selection_views (
  selection_id uuid not null references public.mass_selections(id) on delete cascade,
  viewer_hash text not null check (viewer_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (selection_id, viewer_hash)
);

alter table public.selection_views enable row level security;
grant select, insert on public.selection_views to service_role;

create or replace function public.record_selection_views(
  p_selection_ids uuid[],
  p_viewer_hash text
)
returns table (selection_id uuid, view_count bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_viewer_hash is null or p_viewer_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid viewer hash is required.';
  end if;

  insert into public.selection_views (selection_id, viewer_hash)
  select distinct requested.id, p_viewer_hash
  from unnest(p_selection_ids) as requested(id)
  where requested.id is not null
  on conflict (selection_id, viewer_hash) do nothing;

  return query
  select requested.id, count(views.selection_id)::bigint
  from (
    select distinct selection_id as id
    from unnest(p_selection_ids) as requested(selection_id)
    where selection_id is not null
  ) as requested
  left join public.selection_views as views
    on views.selection_id = requested.id
  group by requested.id;
end;
$$;

revoke all on function public.record_selection_views(uuid[], text) from public, anon, authenticated;
grant execute on function public.record_selection_views(uuid[], text) to service_role;
