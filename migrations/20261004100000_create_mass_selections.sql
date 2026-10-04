create table if not exists public.mass_selections (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 160),
  service_date date not null,
  parts jsonb not null check (jsonb_typeof(parts) = 'array'),
  created_at timestamptz not null default now()
);

alter table public.mass_selections enable row level security;
