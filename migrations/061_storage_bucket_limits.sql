-- ============================================================================
-- 061_storage_bucket_limits.sql
--
-- Defence in depth for file storage. The server already checks type and size
-- before it uploads; this makes the storage buckets refuse anything else too,
-- so a mistake in one route can never put a script or a huge file in a public
-- bucket. Changes no files that are already stored. Safe to run twice.
--
--   company-logos   (public)  images only, 2 MB
--   product-images  (public)  images only, 5 MB
--   invoices        (private) 10 MB; types left to the server, which allows
--                             PDF, PNG and JPEG
-- ============================================================================
update storage.buckets
   set file_size_limit = 2097152,
       allowed_mime_types = array['image/png','image/jpeg','image/gif','image/webp']
 where id = 'company-logos';

update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['image/png','image/jpeg','image/gif','image/webp']
 where id = 'product-images';

update storage.buckets
   set file_size_limit = 10485760
 where id = 'invoices';

select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id;
