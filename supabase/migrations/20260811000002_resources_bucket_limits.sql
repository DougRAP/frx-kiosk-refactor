-- ============================================================================
-- Furniture-Rx · Resources bucket: límites de tamaño y tipos (Parte A, Ago-11)
-- Sube el techo del bucket a 20MB (para PDFs grandes vía subida directa/signed upload) y
-- restringe los tipos. El 10MB de imágenes se enforce en la función (portal-resources), no aquí:
-- el bucket solo tiene UN límite, que es el techo duro (20MB) para PDF.
-- CÓMO APLICAR: SQL Editor de Supabase o `supabase db push`. Idempotente.
-- ============================================================================

BEGIN;

UPDATE storage.buckets
  SET file_size_limit   = 20971520,   -- 20 MB
      allowed_mime_types = ARRAY['application/pdf', 'image/png', 'image/jpeg']
  WHERE id = 'resources';

COMMIT;

-- Verificación:
--   select id, file_size_limit, allowed_mime_types from storage.buckets where id='resources';
