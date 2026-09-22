-- ============================================================================
-- PORT-21: desactivación de dealers en los agregados del admin (16/17-jul).
--
-- POR QUÉ
--   El admin en "Viewing: All" agrega TODOS los dealers. Hace falta poder excluir
--   uno (dealer que se va, piloto que termina, cuenta de demostración) SIN borrar
--   nada: su historia queda íntegra y consultable con "Viewing: ese dealer".
--   Decisión Adrian 17-jul: flag por configuración, expuesto como toggle en la
--   pantalla Dealer Admin del portal (PATCH whitelisted + audit).
--
-- NO DESTRUCTIVO: solo ADD COLUMN IF NOT EXISTS con default true (nada cambia
-- para los dealers existentes hasta que alguien apague el flag).
-- ============================================================================

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS include_in_rollups boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.dealers.include_in_rollups IS
  'false = excluido de los agregados cross-dealer del portal admin (stats, subscribers, commissions, referral codes en "All"). Su data sigue intacta y visible con el scope del propio dealer.';
