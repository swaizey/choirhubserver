create table if not exists public.sheet_music (
  id uuid primary key default gen_random_uuid(),
  drive_file_id text unique,
  title text not null check (length(trim(title)) between 1 and 200),
  composer text not null default '',
  category text not null check (length(trim(category)) between 1 and 120),
  file_url text not null,
  r2_key text not null unique,
  created_at timestamptz not null default now()
);

alter table public.sheet_music enable row level security;

grant select, insert on public.sheet_music to service_role;
