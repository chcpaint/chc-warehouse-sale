-- 048_promotion_images.sql
-- A picture alongside a promotion's item and price.
-- Safe to run more than once.

alter table public.promotions
  add column if not exists image_url  text,
  add column if not exists image_path text;

-- Public bucket: the pictures are marketing images shown to customers on the
-- Promotions tab, and nothing else is ever stored here. Files are only written by
-- the server (service role), after a type and size check.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('promotion-images', 'promotion-images', true, 3145728,
        array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = 3145728,
      allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
