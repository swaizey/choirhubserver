update public.sheet_music
set file_url = replace(
  file_url,
  'pub-b82faeceab0b441b93ebbb3d382ecd17.r2.dev',
  'choirhub-pdfs.choirhub.ng'
)
where position(
  'pub-b82faeceab0b441b93ebbb3d382ecd17.r2.dev'
  in file_url
) > 0;
