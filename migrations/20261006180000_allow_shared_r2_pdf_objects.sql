alter table public.sheet_music
  drop constraint if exists sheet_music_r2_key_key;

create index if not exists sheet_music_r2_key_idx
  on public.sheet_music (r2_key);
