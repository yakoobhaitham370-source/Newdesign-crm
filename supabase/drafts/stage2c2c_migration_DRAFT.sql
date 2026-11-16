-- ============================================================================
-- MASAR CARE — STAGE 2C.2C/2D CLINICAL SAFETY, CONCURRENCY, ALLERGY
-- UNCERTAINTY & IDEMPOTENCY MIGRATION
-- STATUS: DRAFT PROPOSAL ONLY — DO NOT EXECUTE AGAINST LIVE DATABASE
-- TARGET REVIEW PROJECT: bkidngfzsubmyunacnju (Review Only; Current Live = 0004)
--
-- IMPORTANT ROLLOUT & DEPLOYMENT SAFETY DESIGN:
--   1. Pure atomic migration (`BEGIN; ... COMMIT;`) stored in `supabase/drafts/`
--      (NOT `supabase/migrations/`). Existing migrations `0001`–`0004` are intact.
--      Includes Stage 2C.2D pre-migration corrections (canonical INN split,
--      catalog provenance guard, drug-class relationship separation, and
--      deterministic `format_canonical_decimal4` SHA-256 hash alignment).
--   2. Preserves strictly 24 `public` tables with forced RLS (zero new public
--      tables added; reference INN & combination registries live under
--      restricted `app_security` schema).
--   3. Zero test blocks, zero fictional patient/pharmacy records, and zero
--      `ROLLBACK` fixtures appear in this migration file.
--   4. ROLLOUT PHASE 1 (Zero-Downtime Backward Compatibility):
--        - Preserves existing migration `0004` RPC signatures untouched so any
--          connected client still rolling over during deployment operates safely:
--            * public.create_medication_plan_with_version (18 args)
--            * public.update_medication_plan_version (19 args)
--            * public.record_dispensing_with_refill (24 args)
--        - Installs versioned Stage 2C.2C `_v2` RPCs + capability probe:
--            * public.get_clinical_safety_capabilities() (0 args)
--            * public.create_medication_plan_with_version_v2 (19 args)
--            * public.update_medication_plan_version_v2 (21 args)
--            * public.record_dispensing_with_refill_v2 (28 args)
--        - Hardens `public.change_medication_plan_status` (4 args, backward-
--          compatible signature) to block terminal resurrection and archived-
--          patient reactivation.
--   5. ROLLOUT PHASE 2 (Post-Cutover Legacy Retirement):
--        - Provided in `supabase/drafts/stage2c2c_phase2_legacy_rpc_retirement_DRAFT.sql`.
--        - Once 100% of connected sessions probe `get_clinical_safety_capabilities()`
--          and emit `'rpcVersion' = 'v2'` writes, Phase 2 revokes/drops the 3
--          legacy `0004` signatures so direct `0004` bypass becomes impossible.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Idempotency columns & per-pharmacy partial unique index for dispensing
-- ============================================================================
ALTER TABLE public.dispensing_events
  ADD COLUMN IF NOT EXISTS client_event_uuid uuid NULL,
  ADD COLUMN IF NOT EXISTS client_payload_hash text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_dispensing_events_pharmacy_client_uuid
  ON public.dispensing_events (pharmacy_id, client_event_uuid)
  WHERE client_event_uuid IS NOT NULL;

-- ============================================================================
-- 2. Extend `public.medication_catalog` with verified active ingredients,
--    therapeutic classes, and provenance metadata (retains exact 24 `public` tables)
-- ============================================================================
ALTER TABLE public.medication_catalog
  ADD COLUMN IF NOT EXISTS active_ingredients text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS therapeutic_classes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ingredient_verification_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS ingredient_source text NULL,
  ADD COLUMN IF NOT EXISTS ingredient_reviewed_at date NULL,
  ADD COLUMN IF NOT EXISTS ingredient_reviewed_by text NULL,
  ADD COLUMN IF NOT EXISTS ingredient_provenance_notes text NULL;

-- Security & permission model for constraint helper:
--   * `public.medication_catalog` writes are restricted in migration `0002` via
--     `REVOKE ALL ON TABLE public.medication_catalog FROM PUBLIC, anon, authenticated;`
--     and `GRANT SELECT ON public.medication_catalog TO authenticated;`.
--   * Only `postgres`/table owner and `service_role` (which holds `USAGE ON SCHEMA
--     app_security` from `0002` + `EXECUTE` here) can INSERT or UPDATE catalog rows.
--   * Any future non-superuser catalog-maintainer role granted table write privileges
--     MUST also receive `USAGE ON SCHEMA app_security` and `EXECUTE` on this helper,
--     because PostgreSQL evaluates table `CHECK` constraints as `CURRENT_USER`.
CREATE OR REPLACE FUNCTION app_security.text_array_has_non_blank_elements(p_arr text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_arr IS NOT NULL
     AND pg_catalog.array_ndims(p_arr) = 1
     AND pg_catalog.cardinality(p_arr) > 0
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(p_arr) AS elem
       WHERE elem IS NULL
          OR pg_catalog.btrim(pg_catalog.regexp_replace(elem, '\s+', '', 'g')) = ''
     );
$$;

REVOKE ALL ON FUNCTION app_security.text_array_has_non_blank_elements(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.text_array_has_non_blank_elements(text[]) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.medication_catalog'::regclass
      AND conname = 'chk_medication_catalog_ingredient_verification_status'
  ) THEN
    ALTER TABLE public.medication_catalog
      ADD CONSTRAINT chk_medication_catalog_ingredient_verification_status
      CHECK (ingredient_verification_status IN ('verified', 'partial', 'unverified'));
  END IF;

  ALTER TABLE public.medication_catalog
    DROP CONSTRAINT IF EXISTS chk_medication_catalog_verified_provenance;

  ALTER TABLE public.medication_catalog
    ADD CONSTRAINT chk_medication_catalog_verified_provenance
    CHECK (
      COALESCE(ingredient_verification_status, '') <> 'verified'
      OR (
        active_ingredients IS NOT NULL
        AND pg_catalog.array_ndims(active_ingredients) = 1
        AND pg_catalog.cardinality(active_ingredients) > 0
        AND (
          CASE
            WHEN pg_catalog.array_ndims(active_ingredients) = 1
              THEN pg_catalog.array_position(active_ingredients, NULL) IS NULL
            ELSE false
          END
        )
        AND app_security.text_array_has_non_blank_elements(active_ingredients) IS TRUE
        AND pg_catalog.btrim(COALESCE(ingredient_source, '')) <> ''
        AND ingredient_reviewed_at IS NOT NULL
        AND pg_catalog.btrim(COALESCE(ingredient_reviewed_by, '')) <> ''
      )
    );
END $$;

INSERT INTO public.medication_catalog (
  brand_name,
  generic_name,
  available_strengths,
  default_dosage_form,
  default_route,
  category,
  active_ingredients,
  therapeutic_classes,
  ingredient_verification_status,
  ingredient_source,
  ingredient_reviewed_at,
  ingredient_reviewed_by,
  ingredient_provenance_notes,
  is_active
) VALUES
  ('Glucophage', 'Metformin HCl', ARRAY['500 mg', '850 mg', '1000 mg XR'], 'tablet', 'oral', 'Antidiabetic', ARRAY['Metformin HCl'], ARRAY['biguanide'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Single active ingredient verified', true),
  ('Janumet', 'Sitagliptin / Metformin HCl', ARRAY['50/500 mg', '50/850 mg', '50/1000 mg'], 'tablet', 'oral', 'Antidiabetic Combination', ARRAY['Sitagliptin', 'Metformin HCl'], ARRAY['dpp4', 'biguanide'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Fixed-dose combination verified', true),
  ('Norvasc', 'Amlodipine Besylate', ARRAY['5 mg', '10 mg'], 'tablet', 'oral', 'Antihypertensive', ARRAY['Amlodipine Besylate'], ARRAY['ccb'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Single active ingredient verified', true),
  ('Lipitor', 'Atorvastatin', ARRAY['10 mg', '20 mg', '40 mg'], 'tablet', 'oral', 'Lipid-Lowering', ARRAY['Atorvastatin'], ARRAY['statin'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Single active ingredient verified', true),
  ('Cozaar', 'Losartan Potassium', ARRAY['50 mg', '100 mg'], 'tablet', 'oral', 'Antihypertensive (ARB)', ARRAY['Losartan Potassium'], ARRAY['arb'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Single active ingredient verified', true),
  ('Concor', 'Bisoprolol Fumarate', ARRAY['2.5 mg', '5 mg', '10 mg'], 'tablet', 'oral', 'Beta Blocker', ARRAY['Bisoprolol Fumarate'], ARRAY['beta_blocker'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Single active ingredient verified', true),
  ('Euthyrox', 'Levothyroxine Sodium', ARRAY['25 mcg', '50 mcg', '75 mcg', '100 mcg'], 'tablet', 'oral', 'Thyroid Hormone', ARRAY['Levothyroxine Sodium'], ARRAY['thyroid'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Single active ingredient verified', true),
  ('One-Alpha', 'Alfacalcidol', ARRAY['0.25 mcg', '0.5 mcg', '1 mcg'], 'capsule', 'oral', 'Vitamin D Analog', ARRAY['Alfacalcidol'], ARRAY['vitamin_d'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Single active ingredient verified', true),
  ('Symbicort Turbuhaler', 'Budesonide / Formoterol', ARRAY['160/4.5 mcg', '320/9 mcg'], 'inhaler', 'inhalation', 'Respiratory Maintenance', ARRAY['Budesonide', 'Formoterol'], ARRAY['inhaled_corticosteroid', 'laba'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Fixed-dose inhaler combination verified', true),
  ('Ventolin', 'Salbutamol', ARRAY['100 mcg/puff'], 'inhaler', 'inhalation', 'Rescue Bronchodilator', ARRAY['Salbutamol'], ARRAY['saba'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Single active ingredient verified', true),
  ('Lantus SoloStar', 'Insulin Glargine', ARRAY['100 IU/mL'], 'injection', 'subcutaneous', 'Basal Insulin', ARRAY['Insulin Glargine'], ARRAY['insulin'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Explicit insulin analog INN (never collapsed with generic insulin)', true),
  ('Losec', 'Omeprazole', ARRAY['20 mg', '40 mg'], 'capsule', 'oral', 'PPI', ARRAY['Omeprazole'], ARRAY['ppi'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Single active ingredient verified', true),
  ('Marevan', 'Warfarin Sodium', ARRAY['1 mg', '3 mg', '5 mg'], 'tablet', 'oral', 'Anticoagulant', ARRAY['Warfarin Sodium'], ARRAY['warfarin'], 'verified', 'WHO INN / BNF & MASAR Clinical Formulary Review v2026.11', DATE '2026-11-16', 'MASAR Clinical Pharmacology Review (Stage 2C.2D)', 'Single active ingredient verified', true)
ON CONFLICT (brand_name, generic_name, default_dosage_form) DO UPDATE
SET available_strengths = EXCLUDED.available_strengths,
    default_route = EXCLUDED.default_route,
    category = EXCLUDED.category,
    active_ingredients = EXCLUDED.active_ingredients,
    therapeutic_classes = EXCLUDED.therapeutic_classes,
    ingredient_verification_status = EXCLUDED.ingredient_verification_status,
    ingredient_source = EXCLUDED.ingredient_source,
    ingredient_reviewed_at = EXCLUDED.ingredient_reviewed_at,
    ingredient_reviewed_by = EXCLUDED.ingredient_reviewed_by,
    ingredient_provenance_notes = EXCLUDED.ingredient_provenance_notes,
    is_active = true
WHERE public.medication_catalog.ingredient_verification_status <> 'verified'
   OR public.medication_catalog.ingredient_source IS NULL
   OR public.medication_catalog.ingredient_reviewed_at IS NULL
   OR public.medication_catalog.ingredient_reviewed_by IS NULL;

-- ============================================================================
-- 3. Server-side verified INN, combination, broad-class, & cross-reactivity registries
--    (Stored inside restricted `app_security` schema so `public` stays at 24 tables)
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_security.verified_inn_registry (
  canonical_inn text PRIMARY KEY,
  classes text[] NOT NULL DEFAULT '{}',
  aliases text[] NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'WHO INN / MASAR Clinical Formulary Review v2026.11',
  reviewed_at date NOT NULL DEFAULT DATE '2026-11-16',
  reviewed_by text NOT NULL DEFAULT 'MASAR Clinical Pharmacology Review (Stage 2C.2D)',
  provenance_notes text NULL
);

ALTER TABLE app_security.verified_inn_registry
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'WHO INN / MASAR Clinical Formulary Review v2026.11',
  ADD COLUMN IF NOT EXISTS reviewed_at date NOT NULL DEFAULT DATE '2026-11-16',
  ADD COLUMN IF NOT EXISTS reviewed_by text NOT NULL DEFAULT 'MASAR Clinical Pharmacology Review (Stage 2C.2D)',
  ADD COLUMN IF NOT EXISTS provenance_notes text NULL;

REVOKE ALL ON TABLE app_security.verified_inn_registry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE app_security.verified_inn_registry TO service_role;

CREATE TABLE IF NOT EXISTS app_security.verified_combination_registry (
  canonical_product_name text PRIMARY KEY,
  brand_aliases text[] NOT NULL DEFAULT '{}',
  required_ingredients text[] NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'WHO INN / MASAR Clinical Formulary Review v2026.11',
  reviewed_at date NOT NULL DEFAULT DATE '2026-11-16',
  reviewed_by text NOT NULL DEFAULT 'MASAR Clinical Pharmacology Review (Stage 2C.2D)',
  provenance_notes text NULL
);

ALTER TABLE app_security.verified_combination_registry
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'WHO INN / MASAR Clinical Formulary Review v2026.11',
  ADD COLUMN IF NOT EXISTS reviewed_at date NOT NULL DEFAULT DATE '2026-11-16',
  ADD COLUMN IF NOT EXISTS reviewed_by text NOT NULL DEFAULT 'MASAR Clinical Pharmacology Review (Stage 2C.2D)',
  ADD COLUMN IF NOT EXISTS provenance_notes text NULL;

REVOKE ALL ON TABLE app_security.verified_combination_registry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE app_security.verified_combination_registry TO service_role;

CREATE TABLE IF NOT EXISTS app_security.verified_broad_class_labels (
  id text PRIMARY KEY,
  drug_class text NOT NULL,
  labels text[] NOT NULL DEFAULT '{}',
  match_mode text NOT NULL CHECK (match_mode IN ('confirmed_class_allergy', 'nonspecific_class_caution')),
  source text NOT NULL DEFAULT 'WHO INN / MASAR Clinical Formulary Review v2026.11',
  reviewed_at date NOT NULL DEFAULT DATE '2026-11-16',
  reviewed_by text NOT NULL DEFAULT 'MASAR Clinical Pharmacology Review (Stage 2C.2D)'
);

REVOKE ALL ON TABLE app_security.verified_broad_class_labels FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE app_security.verified_broad_class_labels TO service_role;

CREATE TABLE IF NOT EXISTS app_security.verified_drug_class_relationships (
  source_class text NOT NULL,
  target_class text NOT NULL,
  relationship_type text NOT NULL CHECK (relationship_type IN ('same_class_cross_reactivity', 'cross_class_reactivity', 'nonspecific_moiety_caution')),
  clinical_note text NOT NULL,
  source text NOT NULL DEFAULT 'BNF / UpToDate & MASAR Clinical Pharmacology Review v2026.11',
  reviewed_at date NOT NULL DEFAULT DATE '2026-11-16',
  reviewed_by text NOT NULL DEFAULT 'MASAR Clinical Pharmacology Review (Stage 2C.2D)',
  PRIMARY KEY (source_class, target_class)
);

REVOKE ALL ON TABLE app_security.verified_drug_class_relationships FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE app_security.verified_drug_class_relationships TO service_role;

-- Remove deprecated broad key `'penicillin'` if upgrading from an earlier draft
DELETE FROM app_security.verified_inn_registry WHERE canonical_inn = 'penicillin';

-- Every distinct active ingredient has its own canonical INN row; nonspecific class terms
-- (`sulfa`, `sulfonamides`, `penicillin`, `insulin`) are excluded from INN aliases.
INSERT INTO app_security.verified_inn_registry (canonical_inn, classes, aliases, provenance_notes) VALUES
  ('amoxicillin', ARRAY['penicillin'], ARRAY['amoxicillin', 'amoxicillin trihydrate', 'amoxil', 'أموكسيسيلين', 'اموكسيسيلين'], 'Distinct penicillin aminopenicillin INN'),
  ('clavulanic acid', ARRAY['beta_lactamase_inhibitor'], ARRAY['clavulanate', 'clavulanic acid', 'clavulanate potassium', 'كلافولانات'], 'Beta-lactamase inhibitor'),
  ('ampicillin', ARRAY['penicillin'], ARRAY['ampicillin', 'ampicillin sodium', 'أمبيسيلين', 'امبيسيلين'], 'Distinct penicillin INN'),
  ('benzylpenicillin', ARRAY['penicillin'], ARRAY['benzylpenicillin', 'penicillin g', 'benzathine penicillin', 'benzathine benzylpenicillin', 'procaine penicillin', 'بنزيل بنسلين'], 'Distinct Penicillin G molecule'),
  ('phenoxymethylpenicillin', ARRAY['penicillin'], ARRAY['phenoxymethylpenicillin', 'penicillin v', 'فينوكسي ميثيل بنسلين'], 'Distinct Penicillin V molecule'),
  ('piperacillin', ARRAY['penicillin'], ARRAY['piperacillin', 'piperacillin sodium', 'بيبيراسيلين'], 'Distinct ureidopenicillin INN'),
  ('tazobactam', ARRAY['beta_lactamase_inhibitor'], ARRAY['tazobactam', 'tazobactam sodium', 'تازوباكتام'], 'Beta-lactamase inhibitor'),
  ('flucloxacillin', ARRAY['penicillin'], ARRAY['flucloxacillin', 'flucloxacillin sodium', 'فلوكلوكساسيلين'], 'Distinct isoxazolyl penicillin (separated from cloxacillin)'),
  ('cloxacillin', ARRAY['penicillin'], ARRAY['cloxacillin', 'cloxacillin sodium', 'كلوكساسيلين'], 'Distinct isoxazolyl penicillin (separated from flucloxacillin)'),
  ('cephalexin', ARRAY['cephalosporin'], ARRAY['cephalexin', 'cefalexin', 'keflex', 'سيفالكسين'], '1st-gen cephalosporin INN'),
  ('ceftriaxone', ARRAY['cephalosporin'], ARRAY['ceftriaxone', 'ceftriaxone sodium', 'rocephin', 'سيفترياكسون'], '3rd-gen cephalosporin INN'),
  ('cefixime', ARRAY['cephalosporin'], ARRAY['cefixime', 'suprax', 'سيفيكسيم'], '3rd-gen oral cephalosporin INN'),
  ('cefuroxime', ARRAY['cephalosporin'], ARRAY['cefuroxime', 'cefuroxime axetil', 'zinnat'], '2nd-gen cephalosporin INN'),
  ('aspirin', ARRAY['nsaid'], ARRAY['aspirin', 'acetylsalicylic acid', 'asa', 'أسبرين', 'اسبرين'], 'Distinct salicylate NSAID INN'),
  ('ibuprofen', ARRAY['nsaid'], ARRAY['ibuprofen', 'brufen', 'advil', 'إيبوبروفين', 'ايبوبروفين', 'بروفين'], 'Distinct propionic acid NSAID INN'),
  ('diclofenac', ARRAY['nsaid'], ARRAY['diclofenac', 'diclofenac sodium', 'diclofenac potassium', 'voltaren', 'olfen', 'ديكلوفيناك', 'فولتارين'], 'Distinct acetic acid NSAID INN'),
  ('naproxen', ARRAY['nsaid'], ARRAY['naproxen', 'naproxen sodium', 'نابروكسين'], 'Distinct propionic acid NSAID INN'),
  ('meloxicam', ARRAY['nsaid'], ARRAY['meloxicam', 'mobic'], 'Distinct oxicam NSAID INN'),
  ('mefenamic acid', ARRAY['nsaid'], ARRAY['mefenamic', 'mefenamic acid', 'ponstan'], 'Distinct fenamate NSAID INN'),
  ('ketoprofen', ARRAY['nsaid'], ARRAY['ketoprofen', 'كيتوبروفين'], 'Distinct NSAID INN (separated from ketorolac/indomethacin/piroxicam)'),
  ('ketorolac', ARRAY['nsaid'], ARRAY['ketorolac', 'ketorolac tromethamine', 'كيتورولاك'], 'Distinct NSAID INN'),
  ('indomethacin', ARRAY['nsaid'], ARRAY['indomethacin', 'indometacin', 'إندوميثاسين'], 'Distinct NSAID INN'),
  ('piroxicam', ARRAY['nsaid'], ARRAY['piroxicam', 'بيروكسيكام'], 'Distinct oxicam NSAID INN'),
  ('sulfamethoxazole', ARRAY['sulfonamide'], ARRAY['sulfamethoxazole', 'سلفاميثوكسازول'], 'Distinct antibacterial sulfonamide (separated from sulfadiazine/sulfasalazine & generic sulfa)'),
  ('sulfadiazine', ARRAY['sulfonamide'], ARRAY['sulfadiazine', 'سلفاديازين'], 'Distinct antibacterial sulfonamide INN'),
  ('sulfasalazine', ARRAY['sulfonamide'], ARRAY['sulfasalazine', 'سلفاسالازين'], 'Distinct aminosalicylate-sulfonamide DMARD INN'),
  ('trimethoprim', ARRAY['dhfr_inhibitor'], ARRAY['trimethoprim', 'تريميثوبريم'], 'DHFR inhibitor INN'),
  ('metformin hcl', ARRAY['biguanide'], ARRAY['metformin', 'metformin hcl', 'glucophage', 'ميتفورمين', 'غلوكوفاج'], 'Biguanide INN'),
  ('sitagliptin', ARRAY['dpp4'], ARRAY['sitagliptin', 'januvia', 'سيتاغليبتين'], 'DPP-4 inhibitor INN'),
  ('glyburide', ARRAY['sulfonylurea'], ARRAY['glyburide', 'glibenclamide', 'daonil', 'غليبنكلاميد'], 'Sulfonylurea INN'),
  ('insulin glargine', ARRAY['insulin'], ARRAY['insulin glargine', 'lantus', 'lantus solostar', 'glargine', 'أنسولين غلارجين'], 'Explicit long-acting insulin analog INN (excludes bare "insulin")'),
  ('amlodipine besylate', ARRAY['ccb'], ARRAY['amlodipine', 'amlodipine besylate', 'norvasc', 'أملوديبين'], 'Dihydropyridine CCB INN'),
  ('atorvastatin', ARRAY['statin'], ARRAY['atorvastatin', 'lipitor', 'أتورفاستاتين'], 'Distinct statin INN'),
  ('rosuvastatin', ARRAY['statin'], ARRAY['rosuvastatin', 'crestor', 'روسوفاستاتين'], 'Distinct statin INN'),
  ('losartan potassium', ARRAY['arb'], ARRAY['losartan', 'losartan potassium', 'cozaar', 'لوسارتان'], 'ARB INN'),
  ('bisoprolol fumarate', ARRAY['beta_blocker'], ARRAY['bisoprolol', 'bisoprolol fumarate', 'concor', 'بيسوبرولول'], 'Beta blocker INN'),
  ('enalapril', ARRAY['ace_inhibitor'], ARRAY['enalapril', 'enalapril maleate', 'إينالابريل'], 'Distinct ACE inhibitor INN (separated from ramipril/lisinopril/captopril)'),
  ('ramipril', ARRAY['ace_inhibitor'], ARRAY['ramipril', 'راميبريل'], 'Distinct ACE inhibitor INN'),
  ('lisinopril', ARRAY['ace_inhibitor'], ARRAY['lisinopril', 'ليزينوبريل'], 'Distinct ACE inhibitor INN'),
  ('captopril', ARRAY['ace_inhibitor'], ARRAY['captopril', 'كابتوبريل'], 'Distinct ACE inhibitor INN'),
  ('spironolactone', ARRAY['mra'], ARRAY['spironolactone', 'aldactone', 'سبيرونولاكتون'], 'MRA INN'),
  ('clopidogrel', ARRAY['antiplatelet'], ARRAY['clopidogrel', 'plavix', 'كلوبيدوغريل'], 'P2Y12 antiplatelet INN'),
  ('furosemide', ARRAY['loop_diuretic'], ARRAY['furosemide', 'lasix', 'فيوروسيميد'], 'Loop diuretic INN'),
  ('warfarin sodium', ARRAY['warfarin'], ARRAY['warfarin', 'warfarin sodium', 'marevan', 'وارفارين'], 'Vitamin K antagonist INN'),
  ('levothyroxine sodium', ARRAY['thyroid'], ARRAY['levothyroxine', 'levothyroxine sodium', 'euthyrox', 'ليفوثيروكسين'], 'Thyroid hormone INN'),
  ('alfacalcidol', ARRAY['vitamin_d'], ARRAY['alfacalcidol', 'one alpha', 'one-alpha', 'ألفاكالسيدول'], 'Vitamin D analog INN'),
  ('budesonide', ARRAY['inhaled_corticosteroid'], ARRAY['budesonide', 'pulmicort', 'بوديزونيد'], 'Inhaled corticosteroid INN'),
  ('formoterol', ARRAY['laba'], ARRAY['formoterol', 'formoterol fumarate', 'foradil', 'فورموتيرول'], 'LABA INN'),
  ('salbutamol', ARRAY['saba'], ARRAY['salbutamol', 'albuterol', 'ventolin', 'سالبوتامول', 'فنتولين'], 'SABA INN'),
  ('omeprazole', ARRAY['ppi'], ARRAY['omeprazole', 'losec', 'أوميبرازول'], 'PPI INN'),
  ('paracetamol', ARRAY['acetaminophen'], ARRAY['paracetamol', 'acetaminophen', 'panadol', 'باراسيتامول'], 'Analgesic INN'),
  ('azithromycin', ARRAY['macrolide'], ARRAY['azithromycin', 'zithromax', 'أزيثرومايسين'], 'Macrolide INN'),
  ('ciprofloxacin', ARRAY['fluoroquinolone'], ARRAY['ciprofloxacin', 'ciprobay', 'سيبروفلوكساسين'], 'Fluoroquinolone INN'),
  ('methotrexate', ARRAY['dmard'], ARRAY['methotrexate', 'ميثوتريكسات'], 'DMARD INN'),
  ('alendronic acid', ARRAY['bisphosphonate'], ARRAY['alendronate', 'alendronic acid', 'fosamax'], 'Bisphosphonate INN')
ON CONFLICT (canonical_inn) DO UPDATE
SET classes = EXCLUDED.classes,
    aliases = EXCLUDED.aliases,
    source = EXCLUDED.source,
    reviewed_at = EXCLUDED.reviewed_at,
    reviewed_by = EXCLUDED.reviewed_by,
    provenance_notes = EXCLUDED.provenance_notes;

INSERT INTO app_security.verified_combination_registry (
  canonical_product_name, brand_aliases, required_ingredients, provenance_notes
) VALUES
  ('Janumet (Sitagliptin / Metformin HCl)', ARRAY['janumet', 'janumet xr', 'جانوميت'], ARRAY['sitagliptin', 'metformin hcl'], 'Two-ingredient antidiabetic combination'),
  ('Augmentin (Amoxicillin / Clavulanic Acid)', ARRAY['augmentin', 'co-amoxiclav', 'co amoxiclav', 'amoclan', 'klavox', 'megamox', 'أوغمنتين', 'أوجمنتين', 'اوجمنتين'], ARRAY['amoxicillin', 'clavulanic acid'], 'Beta-lactam / beta-lactamase inhibitor combination'),
  ('Tazocin (Piperacillin / Tazobactam)', ARRAY['tazocin', 'تازوسين'], ARRAY['piperacillin', 'tazobactam'], 'Beta-lactam / beta-lactamase inhibitor combination'),
  ('Co-trimoxazole (Trimethoprim / Sulfamethoxazole)', ARRAY['co-trimoxazole', 'co trimoxazole', 'cotrimoxazole', 'bactrim', 'septrin', 'باكتريم', 'سبترين'], ARRAY['trimethoprim', 'sulfamethoxazole'], 'Trimethoprim / sulfonamide combination'),
  ('Symbicort (Budesonide / Formoterol)', ARRAY['symbicort', 'symbicort turbuhaler', 'سيمبيكورت'], ARRAY['budesonide', 'formoterol'], 'Inhaled corticosteroid / LABA combination'),
  ('Glucovance (Glyburide / Metformin HCl)', ARRAY['glucovance', 'غلوكوفانس'], ARRAY['glyburide', 'metformin hcl'], 'Sulfonylurea / biguanide combination')
ON CONFLICT (canonical_product_name) DO UPDATE
SET brand_aliases = EXCLUDED.brand_aliases,
    required_ingredients = EXCLUDED.required_ingredients,
    source = EXCLUDED.source,
    reviewed_at = EXCLUDED.reviewed_at,
    reviewed_by = EXCLUDED.reviewed_by,
    provenance_notes = EXCLUDED.provenance_notes;

INSERT INTO app_security.verified_broad_class_labels (id, drug_class, labels, match_mode) VALUES
  ('penicillin_confirmed', 'penicillin', ARRAY['penicillin', 'penicillins', 'بنسلين', 'beta-lactam', 'beta lactam'], 'confirmed_class_allergy'),
  ('cephalosporin_confirmed', 'cephalosporin', ARRAY['cephalosporin', 'cephalosporins', 'سيفالوسبورين', 'beta-lactam', 'beta lactam'], 'confirmed_class_allergy'),
  ('nsaid_confirmed', 'nsaid', ARRAY['nsaid', 'nsaids', 'مضادات الالتهاب غير الستيرويدية'], 'confirmed_class_allergy'),
  ('analgesic_nsaid_nonspecific', 'nsaid', ARRAY['مسكنات', 'مسكن', 'مسكنات ألم', 'مسكنات الالم', 'مسكنات الألم', 'painkiller', 'painkillers', 'pain killer', 'pain killers', 'analgesic', 'analgesics'], 'nonspecific_class_caution'),
  ('analgesic_acetaminophen_nonspecific', 'acetaminophen', ARRAY['مسكنات', 'مسكن', 'مسكنات ألم', 'مسكنات الالم', 'مسكنات الألم', 'painkiller', 'painkillers', 'pain killer', 'pain killers', 'analgesic', 'analgesics'], 'nonspecific_class_caution'),
  ('sulfonamide_confirmed', 'sulfonamide', ARRAY['sulfonamide', 'sulfonamides', 'سلفوناميد'], 'confirmed_class_allergy'),
  ('sulfonamide_nonspecific', 'sulfonamide', ARRAY['sulfa', 'سلفا'], 'nonspecific_class_caution'),
  ('biguanide_confirmed', 'biguanide', ARRAY['biguanide'], 'confirmed_class_allergy'),
  ('sulfonylurea_confirmed', 'sulfonylurea', ARRAY['sulfonylurea'], 'confirmed_class_allergy'),
  ('ccb_confirmed', 'ccb', ARRAY['dihydropyridine'], 'confirmed_class_allergy'),
  ('statin_confirmed', 'statin', ARRAY['statin', 'statins'], 'confirmed_class_allergy'),
  ('arb_confirmed', 'arb', ARRAY['arb'], 'confirmed_class_allergy'),
  ('beta_blocker_confirmed', 'beta_blocker', ARRAY['beta blocker'], 'confirmed_class_allergy'),
  ('ics_nonspecific', 'inhaled_corticosteroid', ARRAY['corticosteroid', 'steroid', 'steroids', 'كورتيزون', 'كورتيكوستيرويد'], 'nonspecific_class_caution'),
  ('insulin_nonspecific', 'insulin', ARRAY['insulin', 'أنسولين', 'انسولين'], 'nonspecific_class_caution'),
  ('macrolide_confirmed', 'macrolide', ARRAY['macrolide'], 'confirmed_class_allergy'),
  ('fluoroquinolone_confirmed', 'fluoroquinolone', ARRAY['fluoroquinolone'], 'confirmed_class_allergy'),
  ('ace_inhibitor_confirmed', 'ace_inhibitor', ARRAY['ace inhibitor', 'ace inhibitors'], 'confirmed_class_allergy')
ON CONFLICT (id) DO UPDATE
SET drug_class = EXCLUDED.drug_class,
    labels = EXCLUDED.labels,
    match_mode = EXCLUDED.match_mode,
    source = EXCLUDED.source,
    reviewed_at = EXCLUDED.reviewed_at,
    reviewed_by = EXCLUDED.reviewed_by;

INSERT INTO app_security.verified_drug_class_relationships (
  source_class, target_class, relationship_type, clinical_note
) VALUES
  ('penicillin', 'cephalosporin', 'cross_class_reactivity', 'Beta-lactam cross-reactivity caution (Penicillin / Cephalosporin)'),
  ('nsaid', 'nsaid', 'same_class_cross_reactivity', 'NSAID COX-1 class cross-reactivity caution between distinct NSAID agents'),
  ('ace_inhibitor', 'ace_inhibitor', 'same_class_cross_reactivity', 'ACE-inhibitor class caution (angioedema/cough cross-sensitivity risk)'),
  ('penicillin', 'penicillin', 'same_class_cross_reactivity', 'Penicillin class cross-reactivity between distinct penicillin molecules'),
  ('cephalosporin', 'cephalosporin', 'same_class_cross_reactivity', 'Cephalosporin class cross-reactivity caution between distinct agents'),
  ('sulfonamide', 'sulfonamide', 'same_class_cross_reactivity', 'Sulfonamide class caution between distinct sulfonamide agents'),
  ('sulfonamide', 'loop_diuretic', 'nonspecific_moiety_caution', 'Nonspecific sulfa-moiety cross-reactivity caution (non-antibiotic sulfonamide)'),
  ('sulfonamide', 'sulfonylurea', 'nonspecific_moiety_caution', 'Nonspecific sulfa-moiety cross-reactivity caution (non-antibiotic sulfonamide)'),
  ('statin', 'statin', 'same_class_cross_reactivity', 'HMG-CoA reductase inhibitor class caution between distinct statins')
ON CONFLICT (source_class, target_class) DO UPDATE
SET relationship_type = EXCLUDED.relationship_type,
    clinical_note = EXCLUDED.clinical_note,
    source = EXCLUDED.source,
    reviewed_at = EXCLUDED.reviewed_at,
    reviewed_by = EXCLUDED.reviewed_by;

-- ============================================================================
-- 4. Expanded clinical unit normalization
--    100% parity with `src/services/scheduleEngine.ts` + migration `0004`
-- ============================================================================
CREATE OR REPLACE FUNCTION app_security.normalize_clinical_unit_category(p_unit text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_raw text := pg_catalog.btrim(pg_catalog.lower(COALESCE(p_unit, '')));
BEGIN
  IF v_raw = '' THEN
    RETURN '';
  END IF;

  IF v_raw IN ('tablet', 'tablets', 'tab', 'tabs', 'قرص', 'أقراص', 'اقراص', 'حبة', 'حبات') THEN
    RETURN 'tablet';
  ELSIF v_raw IN ('capsule', 'capsules', 'cap', 'caps', 'كبسولة', 'كبسولات') THEN
    RETURN 'capsule';
  ELSIF v_raw IN ('ml', 'ملي', 'مل', 'ميليلتر', 'مليلتر', 'cc') THEN
    RETURN 'ml';
  ELSIF v_raw IN ('puff', 'puffs', 'بخة', 'بخات', 'استنشاق') THEN
    RETURN 'puff';
  ELSIF v_raw IN ('drop', 'drops', 'قطرة', 'قطرات') THEN
    RETURN 'drop';
  ELSIF v_raw IN ('iu', 'iu / inj', 'unit', 'units', 'وحدة', 'وحدات', 'وحدة دولية', 'وحدة / حقنة') THEN
    RETURN 'iu';
  ELSIF v_raw IN ('vial', 'ampoule', 'injection', 'syringe', 'pen', 'إبرة', 'حقنة', 'أمبولة', 'امبولة', 'فيال', 'قلم') THEN
    RETURN 'injection_vial';
  ELSIF v_raw IN ('sachet', 'sachets', 'كيس', 'أكياس', 'اكياس', 'ظرف') THEN
    RETURN 'sachet';
  ELSIF v_raw IN ('mg', 'milligram', 'milligrams', 'ملغ', 'مغ', 'مجم') THEN
    RETURN 'mg';
  ELSIF v_raw IN ('mcg', 'ug', 'µg', 'microgram', 'micrograms', 'ميكروغرام', 'مكغ') THEN
    RETURN 'mcg';
  ELSIF v_raw IN ('g', 'gm', 'gram', 'grams', 'غرام', 'جم', 'غ') THEN
    RETURN 'g';
  ELSIF v_raw IN ('bottle', 'bottles', 'زجاجة', 'عبوة شراب', 'عبوة سائل') THEN
    RETURN 'bottle';
  ELSIF v_raw IN ('pack', 'packs', 'box', 'boxes', 'strip', 'strips', 'عبوة', 'علبة', 'شريط', 'شرائط') THEN
    RETURN 'pack';
  ELSIF v_raw IN ('application', 'applications', 'تطبيق موضعي', 'دهن', 'دهنة') THEN
    RETURN 'application';
  END IF;

  RETURN v_raw;
END;
$$;

REVOKE ALL ON FUNCTION app_security.normalize_clinical_unit_category(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.normalize_clinical_unit_category(text) TO service_role;

-- ============================================================================
-- 5. Shared medication & schedule safety validator helper
--    Matches `src/services/clinicalSafety.ts` and `src/services/scheduleEngine.ts`
-- ============================================================================
CREATE OR REPLACE FUNCTION app_security.validate_medication_clinical_payload(
  p_brand_name text,
  p_generic_name text,
  p_strength text,
  p_dosage_form text,
  p_route text,
  p_dose_amount numeric,
  p_dose_unit text,
  p_verified_instructions text,
  p_start_date date,
  p_end_date date,
  p_is_ongoing boolean,
  p_duration_days integer,
  p_schedule jsonb
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_freq          text;
  v_unit_cat      text;
  v_slots         jsonb;
  v_slot_count    integer;
  v_distinct_time integer;
  v_bad_slot      boolean := false;
  v_times_per_day numeric;
  v_interval_val  numeric;
  v_interval_unit text;
  v_weekdays      jsonb;
  v_weekday_count integer;
  v_weekday_bad   boolean := false;
  v_weekday_dist  integer;
  v_cycle_on      numeric;
  v_cycle_off     numeric;
  v_var_note      text;
  v_prn_ind       text;
  v_prn_max       numeric;
BEGIN
  IF pg_catalog.btrim(COALESCE(p_brand_name, '')) = ''
     AND pg_catalog.btrim(COALESCE(p_generic_name, '')) = ''
  THEN
    RAISE EXCEPTION 'Medication brand_name or generic_name is required.'
      USING ERRCODE = '23514';
  END IF;

  IF pg_catalog.btrim(COALESCE(p_strength, '')) = '' THEN
    RAISE EXCEPTION 'Medication strength is required.'
      USING ERRCODE = '23514';
  END IF;

  IF pg_catalog.char_length(pg_catalog.btrim(COALESCE(p_verified_instructions, ''))) < 5 THEN
    RAISE EXCEPTION 'verified_instructions must be at least 5 characters.'
      USING ERRCODE = '23514';
  END IF;

  IF p_dose_amount IS NULL OR p_dose_amount <= 0 OR p_dose_amount > 10000 THEN
    RAISE EXCEPTION 'Prescribed dose_amount (%) must be > 0 and <= 10000.', p_dose_amount
      USING ERRCODE = '23514';
  END IF;

  v_unit_cat := app_security.normalize_clinical_unit_category(p_dose_unit);
  IF v_unit_cat = '' THEN
    RAISE EXCEPTION 'dose_unit is required.' USING ERRCODE = '23514';
  END IF;

  IF p_start_date IS NULL THEN
    RAISE EXCEPTION 'start_date is required.' USING ERRCODE = '23514';
  END IF;

  IF NOT COALESCE(p_is_ongoing, true) THEN
    IF p_end_date IS NULL OR p_end_date < p_start_date THEN
      RAISE EXCEPTION 'Finite medication plan requires end_date >= start_date.'
        USING ERRCODE = '23514';
    END IF;
    IF p_duration_days IS NOT NULL AND p_duration_days < 1 THEN
      RAISE EXCEPTION 'duration_days must be >= 1 for finite courses.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Dosage form <-> route clinical compatibility
  IF p_dosage_form IN ('tablet', 'capsule', 'syrup', 'sachet') AND p_route <> 'oral' THEN
    RAISE EXCEPTION 'Dosage form % requires oral route (got %).', p_dosage_form, p_route
      USING ERRCODE = '23514';
  ELSIF p_dosage_form = 'inhaler' AND p_route <> 'inhalation' THEN
    RAISE EXCEPTION 'Inhaler dosage form requires inhalation route (got %).', p_route
      USING ERRCODE = '23514';
  ELSIF p_dosage_form = 'injection' AND p_route NOT IN ('subcutaneous', 'intramuscular', 'intravenous') THEN
    RAISE EXCEPTION 'Injection dosage form requires SC, IM, or IV route (got %).', p_route
      USING ERRCODE = '23514';
  ELSIF p_dosage_form = 'drops' AND p_route NOT IN ('ophthalmic', 'otic', 'oral') THEN
    RAISE EXCEPTION 'Drops dosage form requires ophthalmic, otic, or oral route (got %).', p_route
      USING ERRCODE = '23514';
  ELSIF p_dosage_form = 'cream' AND p_route <> 'topical' THEN
    RAISE EXCEPTION 'Cream dosage form requires topical route (got %).', p_route
      USING ERRCODE = '23514';
  ELSIF p_dosage_form NOT IN ('tablet', 'capsule', 'syrup', 'sachet', 'inhaler', 'injection', 'drops', 'cream') THEN
    RAISE EXCEPTION 'Unsupported dosage_form: %.', p_dosage_form
      USING ERRCODE = '23514';
  END IF;

  -- Dosage form <-> dose_unit compatibility (blocks mass/strength unit trap)
  IF v_unit_cat IN ('mg', 'mcg', 'g')
     AND p_dosage_form IN ('tablet', 'capsule', 'syrup', 'inhaler', 'sachet')
  THEN
    RAISE EXCEPTION 'Unit "%" is a strength/mass unit incompatible with dosage form %; use countable/volume administration units.',
      p_dose_unit, p_dosage_form
      USING ERRCODE = '23514';
  END IF;

  IF (p_dosage_form = 'tablet' AND v_unit_cat <> 'tablet')
     OR (p_dosage_form = 'capsule' AND v_unit_cat <> 'capsule')
     OR (p_dosage_form = 'syrup' AND v_unit_cat <> 'ml')
     OR (p_dosage_form = 'inhaler' AND v_unit_cat <> 'puff')
     OR (p_dosage_form = 'injection' AND v_unit_cat NOT IN ('iu', 'injection_vial', 'ml'))
     OR (p_dosage_form = 'drops' AND v_unit_cat NOT IN ('drop', 'ml'))
     OR (p_dosage_form = 'cream' AND v_unit_cat NOT IN ('application', 'g', 'mg'))
     OR (p_dosage_form = 'sachet' AND v_unit_cat <> 'sachet')
  THEN
    RAISE EXCEPTION 'Dose unit "%" (category: %) is incompatible with dosage form %.',
      p_dose_unit, v_unit_cat, p_dosage_form
      USING ERRCODE = '23514';
  END IF;

  -- Schedule envelope
  IF p_schedule IS NULL OR pg_catalog.jsonb_typeof(p_schedule) <> 'object'
     OR COALESCE(p_schedule->>'timezone', '') <> 'Asia/Baghdad'
     OR COALESCE(p_schedule->>'frequencyType', '') NOT IN ('daily', 'interval', 'weekdays', 'cyclic', 'variable', 'prn')
  THEN
    RAISE EXCEPTION 'Invalid schedule structure: Asia/Baghdad timezone and valid frequencyType required.'
      USING ERRCODE = '23514';
  END IF;

  v_freq := p_schedule->>'frequencyType';
  v_slots := COALESCE(p_schedule->'doseSlots', '[]'::jsonb);

  IF pg_catalog.jsonb_typeof(v_slots) <> 'array' THEN
    RAISE EXCEPTION 'schedule.doseSlots must be a JSON array.' USING ERRCODE = '23514';
  END IF;

  v_slot_count := pg_catalog.jsonb_array_length(v_slots);

  IF v_slot_count > 0 THEN
    SELECT
      pg_catalog.count(DISTINCT elem->>'time24'),
      BOOL_OR(
        COALESCE(elem->>'time24', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        OR COALESCE((elem->>'doseAmount')::numeric, 0) <= 0
        OR COALESCE((elem->>'doseAmount')::numeric, 0) > 10000
      )
    INTO v_distinct_time, v_bad_slot
    FROM pg_catalog.jsonb_array_elements(v_slots) AS elem;

    IF COALESCE(v_bad_slot, true) THEN
      RAISE EXCEPTION 'All doseSlots require valid HH:MM time24 and 0 < doseAmount <= 10000.'
        USING ERRCODE = '23514';
    END IF;

    IF v_distinct_time <> v_slot_count THEN
      RAISE EXCEPTION 'Duplicate dose time slots are not allowed in a single medication schedule.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_freq = 'prn' THEN
    IF v_slot_count <> 0 THEN
      RAISE EXCEPTION 'PRN schedules must not contain fixed daily doseSlots.' USING ERRCODE = '23514';
    END IF;
    v_prn_ind := pg_catalog.btrim(COALESCE(p_schedule->>'prnIndication', ''));
    IF pg_catalog.char_length(v_prn_ind) < 2 THEN
      RAISE EXCEPTION 'PRN schedules require prnIndication (>= 2 chars).' USING ERRCODE = '23514';
    END IF;
    IF p_schedule ? 'prnMaxPerDay' AND p_schedule->'prnMaxPerDay' <> 'null'::jsonb THEN
      v_prn_max := (p_schedule->>'prnMaxPerDay')::numeric;
      IF v_prn_max < 1 OR v_prn_max > 24 OR v_prn_max <> pg_catalog.trunc(v_prn_max) THEN
        RAISE EXCEPTION 'PRN prnMaxPerDay must be an integer between 1 and 24.' USING ERRCODE = '23514';
      END IF;
    END IF;

  ELSIF v_freq = 'variable' THEN
    v_var_note := pg_catalog.btrim(COALESCE(p_schedule->>'variablePatternNote', ''));
    IF pg_catalog.char_length(v_var_note) < 4 THEN
      RAISE EXCEPTION 'Variable schedules require variablePatternNote (>= 4 chars).' USING ERRCODE = '23514';
    END IF;

  ELSIF v_freq = 'daily' THEN
    IF v_slot_count < 1 THEN
      RAISE EXCEPTION 'Daily regimen requires at least one doseSlot.' USING ERRCODE = '23514';
    END IF;
    v_times_per_day := NULLIF(p_schedule->>'timesPerDay', '')::numeric;
    IF v_times_per_day IS NULL
       OR v_times_per_day < 1
       OR v_times_per_day > 12
       OR v_times_per_day <> pg_catalog.trunc(v_times_per_day)
       OR v_times_per_day::integer <> v_slot_count
    THEN
      RAISE EXCEPTION 'Daily schedule timesPerDay must be an integer 1..12 matching doseSlots count.'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_freq = 'interval' THEN
    IF v_slot_count < 1 THEN
      RAISE EXCEPTION 'Interval regimen requires at least one anchor doseSlot.' USING ERRCODE = '23514';
    END IF;
    v_interval_unit := COALESCE(p_schedule->>'intervalUnit', '');
    IF v_interval_unit NOT IN ('hours', 'days', 'weeks') THEN
      RAISE EXCEPTION 'Interval schedule requires intervalUnit in (hours, days, weeks).'
        USING ERRCODE = '23514';
    END IF;
    v_interval_val := NULLIF(p_schedule->>'intervalValue', '')::numeric;
    IF v_interval_val IS NULL OR v_interval_val < 1 OR v_interval_val <> pg_catalog.trunc(v_interval_val) THEN
      RAISE EXCEPTION 'Interval schedule requires positive integer intervalValue >= 1.'
        USING ERRCODE = '23514';
    END IF;
    IF v_interval_unit = 'hours' THEN
      IF v_interval_val > 720 THEN
        RAISE EXCEPTION 'Hourly interval cannot exceed 720 hours.' USING ERRCODE = '23514';
      END IF;
      IF v_slot_count <> 1 THEN
        RAISE EXCEPTION 'Hourly interval schedules require exactly 1 anchor doseSlot.' USING ERRCODE = '23514';
      END IF;
    ELSIF v_interval_unit = 'days' AND v_interval_val > 365 THEN
      RAISE EXCEPTION 'Day interval cannot exceed 365 days.' USING ERRCODE = '23514';
    ELSIF v_interval_unit = 'weeks' AND v_interval_val > 52 THEN
      RAISE EXCEPTION 'Week interval cannot exceed 52 weeks.' USING ERRCODE = '23514';
    END IF;

  ELSIF v_freq = 'weekdays' THEN
    IF v_slot_count < 1 THEN
      RAISE EXCEPTION 'Weekdays regimen requires at least one doseSlot.' USING ERRCODE = '23514';
    END IF;
    v_weekdays := p_schedule->'selectedWeekdays';
    IF v_weekdays IS NULL OR pg_catalog.jsonb_typeof(v_weekdays) <> 'array' THEN
      RAISE EXCEPTION 'Weekdays schedule requires selectedWeekdays array.' USING ERRCODE = '23514';
    END IF;
    v_weekday_count := pg_catalog.jsonb_array_length(v_weekdays);
    IF v_weekday_count < 1 THEN
      RAISE EXCEPTION 'Weekdays schedule requires at least one selected weekday (0-6).' USING ERRCODE = '23514';
    END IF;
    SELECT
      pg_catalog.count(DISTINCT elem::text),
      BOOL_OR(
        pg_catalog.jsonb_typeof(elem) <> 'number'
        OR (elem::text)::numeric < 0
        OR (elem::text)::numeric > 6
        OR (elem::text)::numeric <> pg_catalog.trunc((elem::text)::numeric)
      )
    INTO v_weekday_dist, v_weekday_bad
    FROM pg_catalog.jsonb_array_elements(v_weekdays) AS elem;
    IF COALESCE(v_weekday_bad, true) OR v_weekday_dist <> v_weekday_count THEN
      RAISE EXCEPTION 'Weekdays schedule requires distinct integer weekdays between 0 and 6.'
        USING ERRCODE = '23514';
    END IF;

  ELSIF v_freq = 'cyclic' THEN
    IF v_slot_count < 1 THEN
      RAISE EXCEPTION 'Cyclic regimen requires at least one doseSlot.' USING ERRCODE = '23514';
    END IF;
    v_cycle_on := NULLIF(p_schedule->>'cycleOnDays', '')::numeric;
    v_cycle_off := NULLIF(p_schedule->>'cycleOffDays', '')::numeric;
    IF v_cycle_on IS NULL OR v_cycle_on < 1 OR v_cycle_on <> pg_catalog.trunc(v_cycle_on) THEN
      RAISE EXCEPTION 'Cyclic schedule requires integer cycleOnDays >= 1.' USING ERRCODE = '23514';
    END IF;
    IF v_cycle_off IS NULL OR v_cycle_off < 0 OR v_cycle_off <> pg_catalog.trunc(v_cycle_off) THEN
      RAISE EXCEPTION 'Cyclic schedule requires integer cycleOffDays >= 0.' USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_security.validate_medication_clinical_payload(
  text, text, text, text, text, numeric, text, text, date, date, boolean, integer, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.validate_medication_clinical_payload(
  text, text, text, text, text, numeric, text, text, date, date, boolean, integer, jsonb
) TO service_role;

-- ============================================================================
-- 6. Text normalization helper for allergy & INN matching
-- ============================================================================
CREATE OR REPLACE FUNCTION app_security.normalize_clinical_match_text(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_clean text;
BEGIN
  v_clean := pg_catalog.regexp_replace(
    pg_catalog.lower(COALESCE(p_raw, '')),
    '[()[\]{},._/+\\-]+',
    ' ',
    'g'
  );
  v_clean := pg_catalog.btrim(pg_catalog.regexp_replace(v_clean, '\s+', ' ', 'g'));
  RETURN v_clean;
END;
$$;

REVOKE ALL ON FUNCTION app_security.normalize_clinical_match_text(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.normalize_clinical_match_text(text) TO service_role;

-- ============================================================================
-- 7. Server-side ingredient resolution + severe/uncertain allergy assessment
--    Uses `public.medication_catalog`, `app_security.verified_inn_registry`,
--    `app_security.verified_combination_registry`, `app_security.verified_broad_class_labels`,
--    and `app_security.verified_drug_class_relationships`.
--    Distinguishes:
--      - recognized_critical (confirmed severe INN / broad-class conflict)
--      - possible_conflict (class cross-reactivity between distinct INNs,
--        nonspecific class label such as "Sulfa"/"Insulin", or brand/generic contradiction)
--      - unknown_ingredient_coverage (unrecognized free-text/partial combo)
--      - non_severe_conflict
--      - incomplete_chart / verified_clear
-- ============================================================================
DROP FUNCTION IF EXISTS app_security.assess_critical_allergy_conflict(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION app_security.assess_critical_allergy_conflict(
  p_pharmacy_id uuid,
  p_patient_id uuid,
  p_brand_name text,
  p_generic_name text,
  p_catalog_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_norm_brand                text := app_security.normalize_clinical_match_text(p_brand_name);
  v_stripped_brand            text := '';
  v_norm_generic              text := app_security.normalize_clinical_match_text(p_generic_name);
  v_catalog_row               public.medication_catalog%ROWTYPE;
  v_catalog_found             boolean := false;
  v_catalog_matches           boolean := false;
  v_catalog_mismatch          boolean := false;
  v_catalog_unverified        boolean := false;
  v_catalog_inns              text[] := ARRAY[]::text[];
  v_declared_inns             text[] := ARRAY[]::text[];
  v_brand_inns                text[] := ARRAY[]::text[];
  v_brand_exact_verified      boolean := false;
  v_combo_exact_verified      boolean := false;
  v_verified_ingredients      text[] := ARRAY[]::text[];
  v_unverified_ingredients    text[] := ARRAY[]::text[];
  v_med_classes               text[] := ARRAY[]::text[];
  v_part                      text;
  v_part_clean                text;
  v_sub_part                  text;
  v_sub_clean                 text;
  v_inn_row                   record;
  v_combo_row                 record;
  v_brand_contradicts         boolean := false;
  v_brand_suggests_combo      boolean := false;
  v_combo_matched             boolean := false;
  v_has_brand_form_evidence   boolean := false;
  v_has_full_coverage         boolean := false;
  v_has_any_allergies         boolean := false;
  v_has_severe_allergies      boolean := false;
  v_has_critical              boolean := false;
  v_has_non_severe            boolean := false;
  v_has_cross_caution         boolean := false;
  v_has_severe_cross          boolean := false;
  v_allergy                   record;
  v_sub_norm                  text;
  v_alg_inns                  text[];
  v_alg_confirmed_classes     text[];
  v_alg_nonspecific_classes   text[];
  v_alg_candidate_classes     text[];
  v_exact_inn_match           boolean;
  v_confirmed_broad_match     boolean;
  v_unprofiled_direct_match   boolean;
  v_cross_reactivity_match    boolean;
  v_tok                       text;
  v_expanded_med_text         text;
  v_critical_matches          jsonb := '[]'::jsonb;
  v_other_matches             jsonb := '[]'::jsonb;
  v_conflict_category         text;
  v_req_override              boolean := false;
  v_req_review                boolean := false;
  v_req_ack                   boolean := false;
BEGIN
  -- 1. Check catalog entry if provided; unverified/partial, missing, or mismatched catalog IDs fail closed
  IF p_catalog_id IS NOT NULL THEN
    SELECT * INTO v_catalog_row
    FROM public.medication_catalog mc
    WHERE mc.id = p_catalog_id;

    IF NOT FOUND THEN
      v_catalog_unverified := true;
    ELSE
      v_catalog_found := true;
      v_catalog_matches := (
        (v_norm_brand <> '' AND app_security.normalize_clinical_match_text(v_catalog_row.brand_name) = v_norm_brand)
        OR (v_norm_brand = '' AND v_norm_generic <> '' AND app_security.normalize_clinical_match_text(v_catalog_row.generic_name) = v_norm_generic)
      );
      IF v_catalog_row.ingredient_verification_status <> 'verified'
         OR NOT app_security.text_array_has_non_blank_elements(v_catalog_row.active_ingredients)
      THEN
        v_catalog_unverified := true;
      END IF;
      IF NOT v_catalog_matches THEN
        v_catalog_mismatch := true;
      END IF;
    END IF;
  END IF;

  -- 2. Split declared generic_name parts and match longest alias in `verified_inn_registry`
  FOR v_part IN
    SELECT raw_part
    FROM pg_catalog.regexp_split_to_table(
      COALESCE(p_generic_name, ''),
      '([/+,;&]+|\s+(?:and|with|و)\s+)',
      'i'
    ) AS raw_part
  LOOP
    v_part_clean := app_security.normalize_clinical_match_text(v_part);
    IF v_part_clean = '' THEN
      CONTINUE;
    END IF;

    SELECT r.canonical_inn, r.classes
    INTO v_inn_row
    FROM app_security.verified_inn_registry r
    CROSS JOIN LATERAL pg_catalog.unnest(r.aliases) AS al
    WHERE pg_catalog.char_length(app_security.normalize_clinical_match_text(al)) >= 3
      AND (
        v_part_clean = app_security.normalize_clinical_match_text(al)
        OR (' ' || v_part_clean || ' ') LIKE ('% ' || app_security.normalize_clinical_match_text(al) || ' %')
      )
    ORDER BY pg_catalog.char_length(app_security.normalize_clinical_match_text(al)) DESC
    LIMIT 1;

    IF FOUND THEN
      IF NOT (v_inn_row.canonical_inn = ANY(v_declared_inns)) THEN
        v_declared_inns := pg_catalog.array_append(v_declared_inns, v_inn_row.canonical_inn);
      END IF;
      IF NOT (v_inn_row.canonical_inn = ANY(v_verified_ingredients)) THEN
        v_verified_ingredients := pg_catalog.array_append(v_verified_ingredients, v_inn_row.canonical_inn);
      END IF;
      SELECT pg_catalog.array_agg(DISTINCT c)
      INTO v_med_classes
      FROM pg_catalog.unnest(v_med_classes || v_inn_row.classes) AS c;
    ELSE
      v_unverified_ingredients := pg_catalog.array_append(v_unverified_ingredients, v_part_clean);
    END IF;
  END LOOP;

  -- 3. Resolve single-agent INNs implied by brand name (conflict screening + exact single-agent proof)
  IF v_norm_brand <> '' THEN
    v_stripped_brand := pg_catalog.btrim(
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          v_norm_brand,
          '\m(\d+(\.\d+)?|mg|mcg|ug|g|ml|iu|xr|sr|er|cr|mr|dr|xl|hd|la|hcl|sodium|potassium|besylate|fumarate|maleate|tartrate|tromethamine|trihydrate|tablet|tablets|capsule|capsules|syrup|inhaler|turbuhaler|solostar)\M',
          ' ',
          'gi'
        ),
        '\s+',
        ' ',
        'g'
      )
    );

    FOR v_inn_row IN
      SELECT r.canonical_inn, r.classes
      FROM app_security.verified_inn_registry r
      WHERE EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(r.aliases) AS al
        WHERE pg_catalog.char_length(app_security.normalize_clinical_match_text(al)) >= 3
          AND (
            v_norm_brand = app_security.normalize_clinical_match_text(al)
            OR (' ' || v_norm_brand || ' ') LIKE ('% ' || app_security.normalize_clinical_match_text(al) || ' %')
          )
      )
    LOOP
      IF NOT (v_inn_row.canonical_inn = ANY(v_brand_inns)) THEN
        v_brand_inns := pg_catalog.array_append(v_brand_inns, v_inn_row.canonical_inn);
      END IF;
      IF NOT (v_inn_row.canonical_inn = ANY(v_verified_ingredients)) THEN
        v_verified_ingredients := pg_catalog.array_append(v_verified_ingredients, v_inn_row.canonical_inn);
      END IF;
      SELECT pg_catalog.array_agg(DISTINCT c)
      INTO v_med_classes
      FROM pg_catalog.unnest(v_med_classes || v_inn_row.classes) AS c;
    END LOOP;

    SELECT EXISTS (
      SELECT 1
      FROM app_security.verified_inn_registry r
      CROSS JOIN LATERAL pg_catalog.unnest(r.aliases) AS al
      WHERE pg_catalog.char_length(app_security.normalize_clinical_match_text(al)) >= 3
        AND (
          v_norm_brand = app_security.normalize_clinical_match_text(al)
          OR (v_stripped_brand <> '' AND v_stripped_brand = app_security.normalize_clinical_match_text(al))
        )
    ) INTO v_brand_exact_verified;
  END IF;

  -- 4. Detect brand-vs-declared INN contradiction (e.g., Glucophage + Atorvastatin)
  IF COALESCE(pg_catalog.array_length(v_declared_inns, 1), 0) > 0
     AND COALESCE(pg_catalog.array_length(v_brand_inns, 1), 0) > 0
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(v_brand_inns) AS bi
      WHERE NOT (bi = ANY(v_declared_inns))
    ) INTO v_brand_contradicts;

    IF v_brand_contradicts THEN
      v_unverified_ingredients := pg_catalog.array_append(v_unverified_ingredients, 'brand_generic_mismatch');
    END IF;
  END IF;

  -- 5. Expand multi-ingredient combination products (screening) and check exact/approved-suffix
  --    combination brand evidence separately so "Janumet Mystery" never passes completeness checks.
  FOR v_combo_row IN
    SELECT cr.canonical_product_name, cr.required_ingredients
    FROM app_security.verified_combination_registry cr
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(cr.brand_aliases) AS ba
      WHERE pg_catalog.char_length(app_security.normalize_clinical_match_text(ba)) >= 3
        AND (
          v_norm_brand = app_security.normalize_clinical_match_text(ba)
          OR (' ' || v_norm_brand || ' ') LIKE ('% ' || app_security.normalize_clinical_match_text(ba) || ' %')
          OR v_norm_generic = app_security.normalize_clinical_match_text(ba)
          OR (' ' || v_norm_generic || ' ') LIKE ('% ' || app_security.normalize_clinical_match_text(ba) || ' %')
        )
    )
  LOOP
    v_combo_matched := true;
    FOREACH v_part IN ARRAY v_combo_row.required_ingredients
    LOOP
      SELECT r.canonical_inn, r.classes INTO v_inn_row
      FROM app_security.verified_inn_registry r
      WHERE r.canonical_inn = v_part;

      IF FOUND THEN
        IF NOT (v_inn_row.canonical_inn = ANY(v_verified_ingredients)) THEN
          v_verified_ingredients := pg_catalog.array_append(v_verified_ingredients, v_inn_row.canonical_inn);
        END IF;
        SELECT pg_catalog.array_agg(DISTINCT c)
        INTO v_med_classes
        FROM pg_catalog.unnest(v_med_classes || v_inn_row.classes) AS c;
      END IF;

      IF NOT (v_part = ANY(v_declared_inns)) THEN
        v_unverified_ingredients := pg_catalog.array_append(v_unverified_ingredients, 'missing:' || v_part);
      END IF;
    END LOOP;
  END LOOP;

  IF v_norm_brand <> '' THEN
    SELECT EXISTS (
      SELECT 1
      FROM app_security.verified_combination_registry cr
      CROSS JOIN LATERAL pg_catalog.unnest(cr.brand_aliases) AS ba
      WHERE pg_catalog.char_length(app_security.normalize_clinical_match_text(ba)) >= 3
        AND (
          v_norm_brand = app_security.normalize_clinical_match_text(ba)
          OR (v_stripped_brand <> '' AND v_stripped_brand = app_security.normalize_clinical_match_text(ba))
        )
    ) INTO v_combo_exact_verified;
  END IF;

  -- Require complete recognition of EVERY ingredient in a linked catalog entry while
  -- always screening every recognizable catalog ingredient for direct allergy conflicts.
  IF v_catalog_found
     AND v_catalog_row.active_ingredients IS NOT NULL
     AND pg_catalog.cardinality(v_catalog_row.active_ingredients) > 0
  THEN
    FOREACH v_part IN ARRAY v_catalog_row.active_ingredients
    LOOP
      v_part_clean := app_security.normalize_clinical_match_text(v_part);
      SELECT r.canonical_inn, r.classes INTO v_inn_row
      FROM app_security.verified_inn_registry r
      WHERE v_part_clean <> ''
        AND (
          app_security.normalize_clinical_match_text(r.canonical_inn) = v_part_clean
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(r.aliases) AS al
            WHERE app_security.normalize_clinical_match_text(al) = v_part_clean
          )
        )
      LIMIT 1;

      IF FOUND THEN
        IF NOT (v_inn_row.canonical_inn = ANY(v_verified_ingredients)) THEN
          v_verified_ingredients := pg_catalog.array_append(v_verified_ingredients, v_inn_row.canonical_inn);
        END IF;
        SELECT pg_catalog.array_agg(DISTINCT c)
        INTO v_med_classes
        FROM pg_catalog.unnest(v_med_classes || v_inn_row.classes) AS c;

        IF v_catalog_matches THEN
          IF NOT (v_inn_row.canonical_inn = ANY(v_catalog_inns)) THEN
            v_catalog_inns := pg_catalog.array_append(v_catalog_inns, v_inn_row.canonical_inn);
          END IF;
          IF NOT (v_inn_row.canonical_inn = ANY(v_declared_inns))
             AND NOT (('missing:' || v_inn_row.canonical_inn) = ANY(v_unverified_ingredients))
          THEN
            v_unverified_ingredients := pg_catalog.array_append(v_unverified_ingredients, 'missing:' || v_inn_row.canonical_inn);
          END IF;
        END IF;
      ELSE
        -- Any unrecognized ingredient in a linked catalog row fails completeness closed,
        -- while sub-splitting still extracts any recognizable component for screening.
        IF v_catalog_matches THEN
          v_catalog_unverified := true;
          v_unverified_ingredients := pg_catalog.array_append(
            v_unverified_ingredients,
            'unrecognized_catalog:' || COALESCE(NULLIF(v_part_clean, ''), 'blank')
          );
        END IF;

        FOR v_sub_part IN
          SELECT raw_sub
          FROM pg_catalog.regexp_split_to_table(
            COALESCE(v_part, ''),
            '([/+,;&]+|\s+(?:and|with|و)\s+)',
            'i'
          ) AS raw_sub
        LOOP
          v_sub_clean := app_security.normalize_clinical_match_text(v_sub_part);
          IF v_sub_clean = '' THEN
            CONTINUE;
          END IF;
          SELECT r.canonical_inn, r.classes INTO v_inn_row
          FROM app_security.verified_inn_registry r
          CROSS JOIN LATERAL pg_catalog.unnest(r.aliases) AS al
          WHERE pg_catalog.char_length(app_security.normalize_clinical_match_text(al)) >= 3
            AND (
              v_sub_clean = app_security.normalize_clinical_match_text(al)
              OR (' ' || v_sub_clean || ' ') LIKE ('% ' || app_security.normalize_clinical_match_text(al) || ' %')
            )
          ORDER BY pg_catalog.char_length(app_security.normalize_clinical_match_text(al)) DESC
          LIMIT 1;
          IF FOUND THEN
            IF NOT (v_inn_row.canonical_inn = ANY(v_verified_ingredients)) THEN
              v_verified_ingredients := pg_catalog.array_append(v_verified_ingredients, v_inn_row.canonical_inn);
            END IF;
            SELECT pg_catalog.array_agg(DISTINCT c)
            INTO v_med_classes
            FROM pg_catalog.unnest(v_med_classes || v_inn_row.classes) AS c;
          END IF;
        END LOOP;
      END IF;
    END LOOP;

    IF v_catalog_matches
       AND pg_catalog.cardinality(v_declared_inns) > 0
       AND pg_catalog.cardinality(v_catalog_inns) > 0
       AND EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(v_declared_inns) AS di
         WHERE NOT (di = ANY(v_catalog_inns))
       )
    THEN
      v_brand_contradicts := true;
      IF NOT ('brand_generic_mismatch' = ANY(v_unverified_ingredients)) THEN
        v_unverified_ingredients := pg_catalog.array_append(v_unverified_ingredients, 'brand_generic_mismatch');
      END IF;
    END IF;

    IF v_catalog_matches AND NOT v_catalog_unverified THEN
      SELECT pg_catalog.array_agg(DISTINCT c)
      INTO v_med_classes
      FROM pg_catalog.unnest(v_med_classes || v_catalog_row.therapeutic_classes) AS c;
    END IF;
  END IF;

  v_med_classes := COALESCE(v_med_classes, ARRAY[]::text[]);

  v_brand_suggests_combo := (
    COALESCE(p_brand_name, '') ~* '(\m(plus|comp|compound|co-|forte|duo|max)\M|[+/])'
    AND NOT v_combo_exact_verified
    AND NOT (v_catalog_matches AND NOT v_catalog_unverified)
    AND COALESCE(pg_catalog.cardinality(v_declared_inns), 0) < 2
  );

  -- Complete formulation requires reliable proof when a brand name is supplied
  -- (fully verified catalog record, exact/approved-suffix combination product, or exact/approved-suffix single-agent brand/INN)
  v_has_brand_form_evidence := (
    v_norm_brand = ''
    OR v_combo_exact_verified
    OR (v_catalog_matches AND NOT v_catalog_unverified)
    OR v_brand_exact_verified
  );

  IF v_catalog_unverified THEN
    v_unverified_ingredients := pg_catalog.array_append(v_unverified_ingredients, 'unverified_catalog_record');
  END IF;

  IF v_catalog_mismatch THEN
    v_unverified_ingredients := pg_catalog.array_append(v_unverified_ingredients, 'catalog_record_mismatch');
  END IF;

  IF v_norm_brand <> '' AND NOT v_has_brand_form_evidence AND NOT v_brand_contradicts THEN
    v_unverified_ingredients := pg_catalog.array_append(v_unverified_ingredients, 'unrecognized_brand_formulation');
  END IF;

  v_has_full_coverage := (
    COALESCE(pg_catalog.cardinality(v_declared_inns), 0) > 0
    AND COALESCE(pg_catalog.cardinality(v_unverified_ingredients), 0) = 0
    AND NOT v_brand_contradicts
    AND NOT v_catalog_unverified
    AND NOT v_catalog_mismatch
    AND v_has_brand_form_evidence
    AND NOT v_brand_suggests_combo
  );

  v_expanded_med_text := ' ' || app_security.normalize_clinical_match_text(
    COALESCE(p_generic_name, '') || ' ' || COALESCE(p_brand_name, '') || ' ' || pg_catalog.array_to_string(v_verified_ingredients, ' ')
  ) || ' ';

  -- 6. Evaluate every active documented patient allergy using exact-INN vs class-relationship separation
  FOR v_allergy IN
    SELECT pa.id, pa.substance, pa.severity, pa.reaction
    FROM public.patient_allergies pa
    WHERE pa.pharmacy_id = p_pharmacy_id
      AND pa.patient_id = p_patient_id
      AND pa.status = 'active'
  LOOP
    v_has_any_allergies := true;
    IF v_allergy.severity = 'severe' THEN
      v_has_severe_allergies := true;
    END IF;

    v_sub_norm := app_security.normalize_clinical_match_text(v_allergy.substance);
    v_alg_inns := ARRAY[]::text[];
    v_alg_confirmed_classes := ARRAY[]::text[];
    v_alg_nonspecific_classes := ARRAY[]::text[];
    v_alg_candidate_classes := ARRAY[]::text[];

    -- 6a. Resolve canonical INN(s) explicitly named in allergy substance
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT r.canonical_inn), ARRAY[]::text[])
    INTO v_alg_inns
    FROM app_security.verified_inn_registry r
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(r.aliases) AS al
      WHERE pg_catalog.char_length(app_security.normalize_clinical_match_text(al)) >= 3
        AND (
          v_sub_norm = app_security.normalize_clinical_match_text(al)
          OR (' ' || v_sub_norm || ' ') LIKE ('% ' || app_security.normalize_clinical_match_text(al) || ' %')
        )
    );

    -- Expand combination brand if allergy names a known combination product (e.g., Augmentin, Bactrim)
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT req), ARRAY[]::text[])
    INTO v_alg_candidate_classes
    FROM app_security.verified_combination_registry cr
    CROSS JOIN LATERAL pg_catalog.unnest(cr.required_ingredients) AS req
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(cr.brand_aliases) AS ba
      WHERE pg_catalog.char_length(app_security.normalize_clinical_match_text(ba)) >= 3
        AND (
          v_sub_norm = app_security.normalize_clinical_match_text(ba)
          OR (' ' || v_sub_norm || ' ') LIKE ('% ' || app_security.normalize_clinical_match_text(ba) || ' %')
        )
    );
    IF COALESCE(pg_catalog.array_length(v_alg_candidate_classes, 1), 0) > 0 THEN
      SELECT COALESCE(pg_catalog.array_agg(DISTINCT x), ARRAY[]::text[])
      INTO v_alg_inns
      FROM pg_catalog.unnest(v_alg_inns || v_alg_candidate_classes) AS x;
    END IF;

    -- 6b. Resolve broad therapeutic-class & nonspecific allergy labels separately
    SELECT
      COALESCE(pg_catalog.array_agg(DISTINCT b.drug_class) FILTER (WHERE b.match_mode = 'confirmed_class_allergy'), ARRAY[]::text[]),
      COALESCE(pg_catalog.array_agg(DISTINCT b.drug_class) FILTER (WHERE b.match_mode = 'nonspecific_class_caution'), ARRAY[]::text[])
    INTO v_alg_confirmed_classes, v_alg_nonspecific_classes
    FROM app_security.verified_broad_class_labels b
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(b.labels) AS lbl
      WHERE pg_catalog.char_length(app_security.normalize_clinical_match_text(lbl)) >= 3
        AND (
          v_sub_norm = app_security.normalize_clinical_match_text(lbl)
          OR (' ' || v_sub_norm || ' ') LIKE ('% ' || app_security.normalize_clinical_match_text(lbl) || ' %')
        )
    );

    -- 6c. Confirmed conflict ONLY on exact INN match, explicit broad class match, or unprofiled direct match
    v_exact_inn_match := (v_alg_inns && v_verified_ingredients);

    v_confirmed_broad_match := EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(v_alg_confirmed_classes) AS cls
      WHERE CASE
        WHEN cls = 'sulfonamide' THEN
          ('sulfamethoxazole' = ANY(v_verified_ingredients) OR 'sulfadiazine' = ANY(v_verified_ingredients))
        ELSE
          (cls = ANY(v_med_classes))
      END
    );

    v_unprofiled_direct_match := false;
    IF COALESCE(pg_catalog.array_length(v_alg_inns, 1), 0) = 0
       AND COALESCE(pg_catalog.array_length(v_alg_confirmed_classes, 1), 0) = 0
       AND COALESCE(pg_catalog.array_length(v_alg_nonspecific_classes, 1), 0) = 0
       AND v_sub_norm <> ''
    THEN
      FOR v_tok IN
        SELECT tok
        FROM pg_catalog.regexp_split_to_table(v_sub_norm, '\s+') AS tok
        WHERE pg_catalog.char_length(tok) >= 4
          AND tok NOT IN (
            'sulfa', 'sulfonamide', 'sulfonamides', 'penicillin', 'penicillins',
            'cephalosporin', 'cephalosporins', 'nsaid', 'nsaids', 'insulin',
            'steroid', 'steroids', 'painkiller', 'painkillers', 'analgesic', 'analgesics',
            'statin', 'statins', 'acid', 'sodium', 'potassium', 'hcl',
            'maleate', 'fumarate', 'besylate', 'tromethamine',
            'سلفا', 'سلفوناميد', 'بنسلين', 'أنسولين', 'انسولين',
            'مسكنات', 'مسكن', 'كورتيزون', 'كورتيكوستيرويد'
          )
      LOOP
        IF v_expanded_med_text LIKE ('% ' || v_tok || ' %') THEN
          v_unprofiled_direct_match := true;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF v_exact_inn_match OR v_confirmed_broad_match OR v_unprofiled_direct_match THEN
      IF v_allergy.severity = 'severe' THEN
        v_has_critical := true;
        v_critical_matches := v_critical_matches || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'id', v_allergy.id,
            'substance', v_allergy.substance,
            'severity', v_allergy.severity,
            'reaction', v_allergy.reaction
          )
        );
      ELSE
        v_has_non_severe := true;
        v_other_matches := v_other_matches || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'id', v_allergy.id,
            'substance', v_allergy.substance,
            'severity', v_allergy.severity,
            'reaction', v_allergy.reaction
          )
        );
      END IF;
    ELSE
      -- 6d. Class cross-reactivity / nonspecific allergy label caution (`possible_conflict`)
      SELECT COALESCE(pg_catalog.array_agg(DISTINCT c), ARRAY[]::text[])
      INTO v_alg_candidate_classes
      FROM (
        SELECT pg_catalog.unnest(r.classes) AS c
        FROM app_security.verified_inn_registry r
        WHERE r.canonical_inn = ANY(v_alg_inns)
        UNION
        SELECT pg_catalog.unnest(v_alg_confirmed_classes) AS c
        UNION
        SELECT pg_catalog.unnest(v_alg_nonspecific_classes) AS c
      ) cls_union;

      v_cross_reactivity_match := (
        EXISTS (
          SELECT 1
          FROM app_security.verified_drug_class_relationships rel
          WHERE rel.source_class = ANY(v_alg_candidate_classes)
            AND rel.target_class = ANY(v_med_classes)
        )
        OR (v_alg_nonspecific_classes && v_med_classes)
        OR ('sulfonamide' = ANY(v_alg_confirmed_classes) AND 'sulfonamide' = ANY(v_med_classes))
      );

      IF v_cross_reactivity_match THEN
        v_has_cross_caution := true;
        IF v_allergy.severity = 'severe' THEN
          v_has_severe_cross := true;
        END IF;
        v_other_matches := v_other_matches || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'id', v_allergy.id,
            'substance', v_allergy.substance,
            'severity', v_allergy.severity,
            'reaction', v_allergy.reaction
          )
        );
      END IF;
    END IF;
  END LOOP;

  -- 7. Resolve overall conflictCategory & required override/review gates
  IF NOT v_has_any_allergies THEN
    v_conflict_category := 'incomplete_chart';
    v_req_override := false;
    v_req_review := false;
    v_req_ack := false;
  ELSIF v_has_critical THEN
    v_conflict_category := 'recognized_critical';
    v_req_override := true;
    v_req_review := true;
    v_req_ack := true;
  ELSIF v_has_non_severe THEN
    v_conflict_category := 'non_severe_conflict';
    v_req_override := false;
    v_req_review := v_has_severe_allergies;
    v_req_ack := true;
  ELSIF v_has_cross_caution OR v_brand_contradicts THEN
    v_conflict_category := 'possible_conflict';
    v_req_override := false;
    v_req_review := (v_has_severe_allergies OR v_has_severe_cross);
    v_req_ack := true;
  ELSIF NOT v_has_full_coverage THEN
    v_conflict_category := 'unknown_ingredient_coverage';
    v_req_override := false;
    v_req_review := v_has_severe_allergies;
    v_req_ack := true;
  ELSE
    v_conflict_category := 'verified_clear';
    v_req_override := false;
    v_req_review := false;
    v_req_ack := false;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'hasCriticalConflict', v_has_critical,
    'conflictCategory', v_conflict_category,
    'hasSeverePatientAllergies', v_has_severe_allergies,
    'requiresPharmacistAcknowledgment', v_req_ack,
    'requiresDocumentedReview', v_req_review,
    'requiresDocumentedOverride', v_req_override,
    'brandContradictsDeclared', v_brand_contradicts,
    'hasFullIngredientCoverage', v_has_full_coverage,
    'verifiedIngredients', pg_catalog.to_jsonb(v_verified_ingredients),
    'unverifiedIngredients', pg_catalog.to_jsonb(v_unverified_ingredients),
    'matchedSubstances', v_critical_matches || v_other_matches
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.assess_critical_allergy_conflict(uuid, uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.assess_critical_allergy_conflict(uuid, uuid, text, text, uuid)
  TO service_role;

-- ============================================================================
-- 8. Documented critical-allergy & uncertain-coverage evidence validator helper
--    - Critical conflicts require full prescriber + source + clinicalJustification.
--    - `possible_conflict` / `unknown_ingredient_coverage` / `non_severe_conflict`
--      when patient has severe allergies require `acknowledged = true` and
--      `clinicalJustification >= 10 chars` (`SQLSTATE 23514` if missing/NULL).
-- ============================================================================
DROP FUNCTION IF EXISTS app_security.validate_allergy_override_evidence(jsonb, boolean);

CREATE OR REPLACE FUNCTION app_security.validate_allergy_override_evidence(
  p_evidence jsonb,
  p_allergy_eval jsonb
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_req_override  boolean := COALESCE((p_allergy_eval->>'requiresDocumentedOverride')::boolean, false);
  v_req_review    boolean := COALESCE((p_allergy_eval->>'requiresDocumentedReview')::boolean, false);
  v_category      text := COALESCE(p_allergy_eval->>'conflictCategory', 'verified_clear');
  v_level         text;
  v_prescriber    text;
  v_source        text;
  v_justification text;
BEGIN
  IF v_req_override THEN
    IF p_evidence IS NULL THEN
      RAISE EXCEPTION 'Server allergy safety block: severe documented allergy conflict requires structured override documentation.'
        USING ERRCODE = '23514';
    END IF;
    IF pg_catalog.jsonb_typeof(p_evidence) <> 'object' THEN
      RAISE EXCEPTION 'Allergy override evidence must be a JSON object.'
        USING ERRCODE = '22023';
    END IF;
    IF COALESCE(p_evidence->>'level', '') <> 'critical_conflict' THEN
      RAISE EXCEPTION 'Server allergy safety block: severe documented allergy conflict requires level=critical_conflict override documentation.'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_req_review THEN
    IF p_evidence IS NULL THEN
      RAISE EXCEPTION 'Server allergy safety block: documented severe allergy with % requires pharmacist review acknowledgment and clinical justification (>= 10 chars).', v_category
        USING ERRCODE = '23514';
    END IF;
    IF pg_catalog.jsonb_typeof(p_evidence) <> 'object' THEN
      RAISE EXCEPTION 'Allergy review evidence must be a JSON object.'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_evidence IS NULL THEN
    RETURN;
  END IF;

  IF pg_catalog.jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'Allergy override evidence must be a JSON object.'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE((p_evidence->>'acknowledged')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Pharmacist acknowledgment is required inside allergy override evidence.'
      USING ERRCODE = '23514';
  END IF;

  v_level := COALESCE(p_evidence->>'level', '');
  v_justification := pg_catalog.btrim(COALESCE(p_evidence->>'clinicalJustification', ''));

  IF v_req_override OR v_level = 'critical_conflict' THEN
    v_prescriber := pg_catalog.btrim(COALESCE(p_evidence->>'prescriberName', ''));
    v_source := pg_catalog.btrim(COALESCE(p_evidence->>'authorizationSource', ''));

    IF pg_catalog.char_length(v_prescriber) < 2 THEN
      RAISE EXCEPTION 'Critical allergy override requires authorizing prescriberName (>= 2 chars).'
        USING ERRCODE = '23514';
    END IF;

    IF v_source NOT IN ('prescriber_written_order', 'prescriber_verbal_verified', 'pharmacist_clinical_escalation') THEN
      RAISE EXCEPTION 'Critical allergy override requires valid authorizationSource.'
        USING ERRCODE = '23514';
    END IF;

    IF pg_catalog.char_length(v_justification) < 10 THEN
      RAISE EXCEPTION 'Critical allergy override requires clinicalJustification (>= 10 chars).'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_req_review THEN
    IF pg_catalog.char_length(v_justification) < 10 THEN
      RAISE EXCEPTION 'Documented severe allergy with uncertain/cross-reactive coverage (%) requires clinicalJustification (>= 10 chars).', v_category
        USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_security.validate_allergy_override_evidence(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.validate_allergy_override_evidence(jsonb, jsonb)
  TO service_role;

-- ============================================================================
-- 9. Runtime Backend Capability Probe RPC (`get_clinical_safety_capabilities`)
--    Returns explicit boolean capability flags for Stage 2C.2C without any
--    permissive defaults on the client.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_clinical_safety_capabilities()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff record;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'stage', 'stage2c2c_v2',
    'supportsV2MedicationPlans', true,
    'supportsV2DispensingIdempotency', true,
    'enforcesServerCriticalAllergyOverride', true,
    'enforcesServerAllergyUncertainty', true,
    'legacy0004RpcsRetired', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_clinical_safety_capabilities() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_clinical_safety_capabilities() TO authenticated;

-- ============================================================================
-- 10. Hardened Versioned RPC: `public.create_medication_plan_with_version_v2`
--     (Preserves `0004` 18-arg RPC intact for rollout phase 1)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_medication_plan_with_version_v2(
  p_patient_id uuid,
  p_catalog_id uuid,
  p_brand_name text,
  p_generic_name text,
  p_strength text,
  p_dosage_form text,
  p_route text,
  p_dose_amount numeric,
  p_dose_unit text,
  p_food_relation text,
  p_verified_instructions text,
  p_prescriber_name text,
  p_prescriber_specialty text,
  p_start_date date,
  p_end_date date,
  p_is_ongoing boolean,
  p_duration_days integer,
  p_schedule jsonb,
  p_allergy_override_evidence jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff        record;
  v_patient      public.patients%ROWTYPE;
  v_plan_id      uuid;
  v_allergy_eval jsonb;
  v_has_critical boolean := false;
  v_meta         jsonb;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  SELECT * INTO v_patient
  FROM public.patients pt
  WHERE pt.id = p_patient_id
    AND pt.pharmacy_id = v_staff.pharmacy_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient % not found or belongs to another pharmacy.', p_patient_id
      USING ERRCODE = '42501';
  END IF;

  IF v_patient.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot add medication plan for archived patient %.', p_patient_id
      USING ERRCODE = '23514';
  END IF;

  PERFORM app_security.validate_medication_clinical_payload(
    p_brand_name,
    p_generic_name,
    p_strength,
    p_dosage_form,
    p_route,
    p_dose_amount,
    p_dose_unit,
    p_verified_instructions,
    p_start_date,
    p_end_date,
    p_is_ongoing,
    p_duration_days,
    p_schedule
  );

  v_allergy_eval := app_security.assess_critical_allergy_conflict(
    v_staff.pharmacy_id,
    p_patient_id,
    p_brand_name,
    p_generic_name,
    p_catalog_id
  );
  v_has_critical := COALESCE((v_allergy_eval->>'hasCriticalConflict')::boolean, false);

  PERFORM app_security.validate_allergy_override_evidence(
    p_allergy_override_evidence,
    v_allergy_eval
  );

  INSERT INTO public.patient_medication_plans (
    pharmacy_id, patient_id, catalog_id, brand_name, generic_name, strength,
    dosage_form, route, dose_amount, dose_unit, food_relation,
    verified_instructions, prescriber_name, prescriber_specialty,
    start_date, end_date, is_ongoing, duration_days,
    status, current_version_number, schedule, created_by_staff_id
  )
  VALUES (
    v_staff.pharmacy_id, p_patient_id, p_catalog_id,
    pg_catalog.btrim(p_brand_name), pg_catalog.btrim(p_generic_name), pg_catalog.btrim(p_strength),
    p_dosage_form, p_route, p_dose_amount, pg_catalog.btrim(p_dose_unit), p_food_relation,
    pg_catalog.btrim(p_verified_instructions),
    NULLIF(pg_catalog.btrim(COALESCE(p_prescriber_name, '')), ''),
    NULLIF(pg_catalog.btrim(COALESCE(p_prescriber_specialty, '')), ''),
    p_start_date,
    CASE WHEN COALESCE(p_is_ongoing, true) THEN NULL ELSE p_end_date END,
    COALESCE(p_is_ongoing, true),
    CASE WHEN COALESCE(p_is_ongoing, true) THEN NULL ELSE p_duration_days END,
    'active',
    1,
    p_schedule,
    v_staff.staff_id
  )
  RETURNING id INTO v_plan_id;

  INSERT INTO public.regimen_versions (
    pharmacy_id, medication_plan_id, version_number, effective_from, effective_to,
    dose_amount, dose_unit, food_relation, verified_instructions, schedule,
    changed_by_staff_id, changed_by_staff_name, change_reason
  )
  VALUES (
    v_staff.pharmacy_id, v_plan_id, 1, p_start_date, NULL,
    p_dose_amount, pg_catalog.btrim(p_dose_unit), p_food_relation, pg_catalog.btrim(p_verified_instructions), p_schedule,
    v_staff.staff_id, v_staff.full_name,
    'خطة علاجية جديدة موثقة من الصيدلي / Initial pharmacist-verified plan'
  );

  v_meta := pg_catalog.jsonb_build_object(
    'rpcVersion', 'v2',
    'patientId', p_patient_id,
    'versionNumber', 1,
    'serverCriticalAllergyDetected', v_has_critical,
    'allergyEvaluation', v_allergy_eval
  );
  IF p_allergy_override_evidence IS NOT NULL THEN
    v_meta := v_meta || pg_catalog.jsonb_build_object('allergyOverride', p_allergy_override_evidence);
  END IF;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'MEDICATION_PLAN_ADDED',
    'medication_plan',
    v_plan_id,
    'إضافة خطة علاجية (' || pg_catalog.btrim(p_brand_name) || ' ' || pg_catalog.btrim(p_strength) || ') للمراجع ' || v_patient.full_name,
    'Added medication plan (' || pg_catalog.btrim(p_brand_name) || ' ' || pg_catalog.btrim(p_strength) || ') for ' || v_patient.full_name,
    v_meta
  );

  RETURN jsonb_build_object(
    'ok', true,
    'planId', v_plan_id,
    'versionNumber', 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_medication_plan_with_version_v2(
  uuid, uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_medication_plan_with_version_v2(
  uuid, uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, jsonb
) TO authenticated;

-- ============================================================================
-- 11. Hardened Versioned RPC: `public.update_medication_plan_version_v2`
--     Requires explicit non-null `p_expected_version_number >= 1` (no bypass),
--     blocks archived patients and terminal plans, enforces server allergy check.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.update_medication_plan_version_v2(
  p_plan_id uuid,
  p_brand_name text,
  p_generic_name text,
  p_strength text,
  p_dosage_form text,
  p_route text,
  p_dose_amount numeric,
  p_dose_unit text,
  p_food_relation text,
  p_verified_instructions text,
  p_prescriber_name text,
  p_prescriber_specialty text,
  p_start_date date,
  p_end_date date,
  p_is_ongoing boolean,
  p_duration_days integer,
  p_schedule jsonb,
  p_change_reason text,
  p_effective_date date,
  p_expected_version_number integer,
  p_allergy_override_evidence jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff        record;
  v_plan         public.patient_medication_plans%ROWTYPE;
  v_patient      public.patients%ROWTYPE;
  v_open_version public.regimen_versions%ROWTYPE;
  v_next_ver     integer;
  v_eff_date     date;
  v_clean_reason text;
  v_allergy_eval jsonb;
  v_has_critical boolean := false;
  v_meta         jsonb;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  IF p_expected_version_number IS NULL OR p_expected_version_number < 1 THEN
    RAISE EXCEPTION 'p_expected_version_number (>= 1) is required for versioned medication updates.'
      USING ERRCODE = '23514';
  END IF;

  v_clean_reason := pg_catalog.btrim(COALESCE(p_change_reason, ''));
  IF pg_catalog.char_length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'A regimen change reason of at least 3 characters is required.'
      USING ERRCODE = '23514';
  END IF;

  PERFORM app_security.validate_medication_clinical_payload(
    p_brand_name,
    p_generic_name,
    p_strength,
    p_dosage_form,
    p_route,
    p_dose_amount,
    p_dose_unit,
    p_verified_instructions,
    p_start_date,
    p_end_date,
    p_is_ongoing,
    p_duration_days,
    p_schedule
  );

  SELECT * INTO v_plan
  FROM public.patient_medication_plans mp
  WHERE mp.id = p_plan_id
    AND mp.pharmacy_id = v_staff.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Medication plan % not found or belongs to another pharmacy.', p_plan_id
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_patient
  FROM public.patients pt
  WHERE pt.id = v_plan.patient_id
    AND pt.pharmacy_id = v_staff.pharmacy_id
  FOR SHARE;

  IF NOT FOUND OR v_patient.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot edit medication plan for archived patient %.', v_plan.patient_id
      USING ERRCODE = '23514';
  END IF;

  IF v_plan.status IN ('discontinued', 'archived') THEN
    RAISE EXCEPTION 'Cannot edit a discontinued or archived medication plan (%). Historical regimens are immutable.', v_plan.id
      USING ERRCODE = '23514';
  END IF;

  IF v_plan.current_version_number <> p_expected_version_number THEN
    RAISE EXCEPTION 'Stale regimen version conflict: expected v%, current v%.',
      p_expected_version_number, v_plan.current_version_number
      USING ERRCODE = '40001';
  END IF;

  v_allergy_eval := app_security.assess_critical_allergy_conflict(
    v_staff.pharmacy_id,
    v_plan.patient_id,
    p_brand_name,
    p_generic_name,
    v_plan.catalog_id
  );
  v_has_critical := COALESCE((v_allergy_eval->>'hasCriticalConflict')::boolean, false);

  PERFORM app_security.validate_allergy_override_evidence(
    p_allergy_override_evidence,
    v_allergy_eval
  );

  v_eff_date := COALESCE(p_effective_date, (pg_catalog.now() AT TIME ZONE 'Asia/Baghdad')::date);

  SELECT * INTO v_open_version
  FROM public.regimen_versions rv
  WHERE rv.medication_plan_id = p_plan_id
    AND rv.pharmacy_id = v_staff.pharmacy_id
    AND rv.effective_to IS NULL
  FOR UPDATE;

  IF FOUND THEN
    IF v_eff_date < v_open_version.effective_from THEN
      RAISE EXCEPTION 'Effective date % cannot precede open regimen version effective_from %.',
        v_eff_date, v_open_version.effective_from
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.regimen_versions
       SET effective_to = v_eff_date
     WHERE id = v_open_version.id
       AND pharmacy_id = v_staff.pharmacy_id;
  END IF;

  v_next_ver := v_plan.current_version_number + 1;

  INSERT INTO public.regimen_versions (
    pharmacy_id, medication_plan_id, version_number, effective_from, effective_to,
    dose_amount, dose_unit, food_relation, verified_instructions, schedule,
    changed_by_staff_id, changed_by_staff_name, change_reason
  )
  VALUES (
    v_staff.pharmacy_id, p_plan_id, v_next_ver, v_eff_date, NULL,
    p_dose_amount, pg_catalog.btrim(p_dose_unit), p_food_relation, pg_catalog.btrim(p_verified_instructions), p_schedule,
    v_staff.staff_id, v_staff.full_name, v_clean_reason
  );

  UPDATE public.patient_medication_plans
     SET brand_name = pg_catalog.btrim(p_brand_name),
         generic_name = pg_catalog.btrim(p_generic_name),
         strength = pg_catalog.btrim(p_strength),
         dosage_form = p_dosage_form,
         route = p_route,
         dose_amount = p_dose_amount,
         dose_unit = pg_catalog.btrim(p_dose_unit),
         food_relation = p_food_relation,
         verified_instructions = pg_catalog.btrim(p_verified_instructions),
         prescriber_name = NULLIF(pg_catalog.btrim(COALESCE(p_prescriber_name, '')), ''),
         prescriber_specialty = NULLIF(pg_catalog.btrim(COALESCE(p_prescriber_specialty, '')), ''),
         start_date = p_start_date,
         end_date = CASE WHEN COALESCE(p_is_ongoing, true) THEN NULL ELSE p_end_date END,
         is_ongoing = COALESCE(p_is_ongoing, true),
         duration_days = CASE WHEN COALESCE(p_is_ongoing, true) THEN NULL ELSE p_duration_days END,
         current_version_number = v_next_ver,
         schedule = p_schedule,
         updated_at = pg_catalog.now()
   WHERE id = p_plan_id
     AND pharmacy_id = v_staff.pharmacy_id;

  v_meta := pg_catalog.jsonb_build_object(
    'rpcVersion', 'v2',
    'versionNumber', v_next_ver,
    'effectiveDate', v_eff_date,
    'reason', v_clean_reason,
    'serverCriticalAllergyDetected', v_has_critical,
    'allergyEvaluation', v_allergy_eval
  );
  IF p_allergy_override_evidence IS NOT NULL THEN
    v_meta := v_meta || pg_catalog.jsonb_build_object('allergyOverride', p_allergy_override_evidence);
  END IF;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'REGIMEN_VERSION_CREATED',
    'medication_plan',
    p_plan_id,
    'تعديل خطة ' || pg_catalog.btrim(p_brand_name) || ' وحفظ النسخة رقم ' || v_next_ver,
    'Updated ' || pg_catalog.btrim(p_brand_name) || ' plan (preserved version #' || v_next_ver || ')',
    v_meta
  );

  RETURN jsonb_build_object(
    'ok', true,
    'planId', p_plan_id,
    'versionNumber', v_next_ver
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_medication_plan_version_v2(
  uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, text, date, integer, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_medication_plan_version_v2(
  uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, text, date, integer, jsonb
) TO authenticated;

-- ============================================================================
-- 12. Hardened `public.change_medication_plan_status` (4 args preserved)
--     Blocks terminal plan resurrection and transitions for archived patients.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.change_medication_plan_status(
  p_plan_id uuid,
  p_status text,
  p_reason text,
  p_effective_date date DEFAULT (pg_catalog.now() AT TIME ZONE 'Asia/Baghdad')::date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff        record;
  v_plan         public.patient_medication_plans%ROWTYPE;
  v_patient      public.patients%ROWTYPE;
  v_open_pause   public.medication_pause_periods%ROWTYPE;
  v_eff_date     date;
  v_clean_reason text;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  IF p_status IS NULL OR p_status NOT IN ('active', 'paused', 'discontinued', 'archived') THEN
    RAISE EXCEPTION 'Invalid medication plan status: %.', p_status USING ERRCODE = '23514';
  END IF;

  v_clean_reason := pg_catalog.btrim(COALESCE(p_reason, ''));
  IF pg_catalog.char_length(v_clean_reason) < 2 THEN
    RAISE EXCEPTION 'Status change reason must be at least 2 characters.' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_plan
  FROM public.patient_medication_plans mp
  WHERE mp.id = p_plan_id
    AND mp.pharmacy_id = v_staff.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Medication plan % not found or belongs to another pharmacy.', p_plan_id
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_patient
  FROM public.patients pt
  WHERE pt.id = v_plan.patient_id
    AND pt.pharmacy_id = v_staff.pharmacy_id
  FOR SHARE;

  IF v_plan.status = 'archived' THEN
    RAISE EXCEPTION 'Cannot transition an archived medication plan.' USING ERRCODE = '23514';
  END IF;

  IF v_plan.status = 'discontinued' AND p_status IN ('active', 'paused') THEN
    RAISE EXCEPTION 'Cannot reactivate or pause a discontinued medication plan.' USING ERRCODE = '23514';
  END IF;

  IF (NOT FOUND OR v_patient.status <> 'active') AND p_status IN ('active', 'paused') THEN
    RAISE EXCEPTION 'Cannot activate or pause medication plan for archived patient %.', v_plan.patient_id
      USING ERRCODE = '23514';
  END IF;

  v_eff_date := COALESCE(p_effective_date, (pg_catalog.now() AT TIME ZONE 'Asia/Baghdad')::date);

  SELECT * INTO v_open_pause
  FROM public.medication_pause_periods mpp
  WHERE mpp.medication_plan_id = p_plan_id
    AND mpp.pharmacy_id = v_staff.pharmacy_id
    AND mpp.resumed_at IS NULL
  FOR UPDATE;

  IF p_status = 'paused' THEN
    IF NOT FOUND THEN
      INSERT INTO public.medication_pause_periods (
        pharmacy_id, medication_plan_id, paused_from, resumed_at, reason, recorded_by_staff_id
      )
      VALUES (
        v_staff.pharmacy_id, p_plan_id, v_eff_date, NULL, v_clean_reason, v_staff.staff_id
      );
    END IF;
  ELSE
    IF FOUND THEN
      IF v_eff_date < v_open_pause.paused_from THEN
        RAISE EXCEPTION 'Resume/stop date % cannot precede pause start date %.',
          v_eff_date, v_open_pause.paused_from
          USING ERRCODE = '23514';
      END IF;

      UPDATE public.medication_pause_periods
         SET resumed_at = v_eff_date
       WHERE id = v_open_pause.id
         AND pharmacy_id = v_staff.pharmacy_id;
    END IF;
  END IF;

  UPDATE public.patient_medication_plans
     SET status = p_status,
         status_changed_at = CASE WHEN p_status = 'active' THEN NULL ELSE v_eff_date END,
         status_change_reason = v_clean_reason,
         updated_at = pg_catalog.now()
   WHERE id = p_plan_id
     AND pharmacy_id = v_staff.pharmacy_id;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'MEDICATION_STATUS_CHANGED',
    'medication_plan',
    p_plan_id,
    'تغيير حالة ' || v_plan.brand_name || ' إلى (' || p_status || ')',
    'Changed status of ' || v_plan.brand_name || ' to ' || p_status,
    pg_catalog.jsonb_build_object('status', p_status, 'effectiveDate', v_eff_date, 'reason', v_clean_reason)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'planId', p_plan_id,
    'status', p_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.change_medication_plan_status(
  uuid, text, text, date
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_medication_plan_status(
  uuid, text, text, date
) TO authenticated;

-- ============================================================================
-- 13. Deterministic decimal formatter (`format_canonical_decimal4`) &
--     Hardened Versioned RPC: `public.record_dispensing_with_refill_v2`
--     Full 4-group canonical SHA-256 fingerprint (byte-for-byte parity with
--     `clinicalSafety.ts`), shadow hash comparison audit telemetry,
--     advisory lock + unique index idempotency, strict expected version `40001`,
--     and full allergy/uncertain-coverage gate.
-- ============================================================================
CREATE OR REPLACE FUNCTION app_security.format_canonical_decimal4(p_val numeric)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_rounded numeric;
BEGIN
  IF p_val IS NULL THEN
    RETURN '<NULL>';
  END IF;
  v_rounded := pg_catalog.round(p_val, 4);
  IF v_rounded = 0 THEN
    RETURN '0.0000';
  END IF;
  RETURN pg_catalog.btrim(
    pg_catalog.to_char(v_rounded, 'FM99999999999999999999999999990.0000')
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.format_canonical_decimal4(numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.format_canonical_decimal4(numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.record_dispensing_with_refill_v2(
  p_patient_id uuid,
  p_medication_plan_id uuid,
  p_dispensed_quantity numeric,
  p_quantity_unit text,
  p_package_count integer,
  p_package_size numeric,
  p_batch_number text,
  p_expiry_date date,
  p_dispensing_date date,
  p_is_partial_fill boolean,
  p_notes text,
  p_estimated_daily_consumption numeric,
  p_estimated_supply_days integer,
  p_estimated_supply_end_date date,
  p_forecast_assumptions text,
  p_total_dispensed_analyzed numeric,
  p_estimated_remaining_units numeric,
  p_estimated_days_remaining integer,
  p_refill_status text,
  p_refill_supply_end_date date,
  p_uncertainty_note text,
  p_calculation_source text,
  p_algorithm_version text,
  p_calculation_inputs jsonb,
  p_expected_regimen_version_number integer,
  p_client_event_uuid uuid,
  p_client_payload_hash text DEFAULT NULL,
  p_allergy_override_evidence jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff                      record;
  v_plan                       public.patient_medication_plans%ROWTYPE;
  v_patient                    public.patients%ROWTYPE;
  v_existing_dispense          public.dispensing_events%ROWTYPE;
  v_dispense_id                uuid;
  v_clean_unit                 text;
  v_clean_client_hash          text;
  v_client_hash_matched        boolean := NULL;
  v_ov_level                   text;
  v_ov_ack                     boolean;
  v_ov_presc                   text;
  v_ov_src                     text;
  v_ov_ref                     text;
  v_ov_just                    text;
  v_override_part              text;
  v_refill_part                text;
  v_canonical_payload          text;
  v_server_payload_hash        text;
  v_dose_unit_cat              text;
  v_disp_unit_cat              text;
  v_units_compatible           boolean;
  v_server_daily_rate          numeric;
  v_auth_total_dispensed       numeric;
  v_freq                       text;
  v_allergy_eval               jsonb;
  v_has_critical               boolean := false;
  v_calc_source                text := 'provisional_client_unverified';
  v_verif_status               text := 'provisional_unverified';
  v_eff_daily_consumption      numeric;
  v_eff_supply_days            integer;
  v_eff_supply_end_date        date;
  v_eff_remaining_units        numeric;
  v_eff_days_remaining         integer;
  v_eff_refill_supply_end_date date;
  v_eff_assumptions            text;
  v_eff_uncertainty            text;
  v_inputs_snapshot            jsonb;
  v_audit_meta                 jsonb;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  IF p_client_event_uuid IS NULL THEN
    RAISE EXCEPTION 'p_client_event_uuid is required for v2 idempotent dispensing.'
      USING ERRCODE = '23514';
  END IF;

  IF p_expected_regimen_version_number IS NULL OR p_expected_regimen_version_number < 1 THEN
    RAISE EXCEPTION 'p_expected_regimen_version_number (>= 1) is required for v2 dispensing.'
      USING ERRCODE = '23514';
  END IF;

  IF p_dispensed_quantity IS NULL OR p_dispensed_quantity <= 0 OR p_dispensed_quantity > 100000 THEN
    RAISE EXCEPTION 'Dispensed quantity must be between 0 and 100000.' USING ERRCODE = '23514';
  END IF;

  IF p_dispensing_date IS NULL THEN
    RAISE EXCEPTION 'Dispensing date is required.' USING ERRCODE = '23514';
  END IF;

  IF p_expiry_date IS NOT NULL AND p_expiry_date < p_dispensing_date THEN
    RAISE EXCEPTION 'Safety block: cannot dispense expired batch (% < %).', p_expiry_date, p_dispensing_date
      USING ERRCODE = '23514';
  END IF;

  v_clean_unit := pg_catalog.btrim(COALESCE(p_quantity_unit, ''));
  IF pg_catalog.char_length(v_clean_unit) < 1 THEN
    RAISE EXCEPTION 'Dispensed quantity unit is required.' USING ERRCODE = '23514';
  END IF;

  IF p_refill_status NOT IN ('overdue', 'due_soon', 'upcoming', 'on_track', 'unable_to_estimate', 'paused_or_prn') THEN
    RAISE EXCEPTION 'Invalid refill_status: %.', p_refill_status USING ERRCODE = '23514';
  END IF;

  IF (p_estimated_daily_consumption IS NOT NULL AND p_estimated_daily_consumption < 0)
     OR (p_estimated_supply_days IS NOT NULL AND (p_estimated_supply_days < 0 OR p_estimated_supply_days > 3650))
     OR (p_estimated_remaining_units IS NOT NULL AND p_estimated_remaining_units < 0)
     OR (p_total_dispensed_analyzed IS NOT NULL AND p_total_dispensed_analyzed <= 0)
  THEN
    RAISE EXCEPTION 'Invalid negative or out-of-bounds refill forecast parameter.' USING ERRCODE = '23514';
  END IF;

  IF p_package_count IS NOT NULL AND p_package_count < 1 THEN
    RAISE EXCEPTION 'package_count must be >= 1 when provided.' USING ERRCODE = '23514';
  END IF;

  IF p_package_size IS NOT NULL AND p_package_size <= 0 THEN
    RAISE EXCEPTION 'package_size must be > 0 when provided.' USING ERRCODE = '23514';
  END IF;

  IF p_package_count IS NOT NULL AND p_package_size IS NOT NULL THEN
    IF NOT COALESCE(p_is_partial_fill, false)
       AND pg_catalog.abs(p_dispensed_quantity - (p_package_count * p_package_size)) > 0.0001
    THEN
      RAISE EXCEPTION 'Dispensed quantity (%) does not match package math (% x %) without partial fill flag.',
        p_dispensed_quantity, p_package_count, p_package_size
        USING ERRCODE = '23514';
    ELSIF COALESCE(p_is_partial_fill, false)
       AND p_dispensed_quantity > (p_package_count * p_package_size) + 0.0001
    THEN
      RAISE EXCEPTION 'Partial fill quantity (%) cannot exceed total package quantity (%).',
        p_dispensed_quantity, (p_package_count * p_package_size)
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF p_calculation_inputs IS NOT NULL AND pg_catalog.jsonb_typeof(p_calculation_inputs) <> 'object' THEN
    RAISE EXCEPTION 'p_calculation_inputs must be a JSON object.' USING ERRCODE = '22023';
  END IF;

  v_clean_client_hash := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_client_payload_hash, ''))), '');

  -- Canonical 4-group server SHA-256 fingerprint (matches `buildCanonicalDispensingFingerprintString` in `clinicalSafety.ts`):
  --   1) Core dispense parameters
  --   2) p_expected_regimen_version_number
  --   3) Canonical p_allergy_override_evidence (non-volatile clinical fields)
  --   4) All 12 refill forecast & assessment inputs
  IF p_allergy_override_evidence IS NULL OR pg_catalog.jsonb_typeof(p_allergy_override_evidence) <> 'object' THEN
    v_override_part := '<NULL>';
  ELSE
    v_ov_level := NULLIF(pg_catalog.btrim(COALESCE(p_allergy_override_evidence->>'level', '')), '');
    v_ov_ack   := COALESCE((p_allergy_override_evidence->>'acknowledged')::boolean, false);
    v_ov_presc := NULLIF(pg_catalog.btrim(COALESCE(p_allergy_override_evidence->>'prescriberName', '')), '');
    v_ov_src   := NULLIF(pg_catalog.btrim(COALESCE(p_allergy_override_evidence->>'authorizationSource', '')), '');
    v_ov_ref   := NULLIF(pg_catalog.btrim(COALESCE(p_allergy_override_evidence->>'authorizationReference', '')), '');
    v_ov_just  := NULLIF(pg_catalog.btrim(COALESCE(p_allergy_override_evidence->>'clinicalJustification', '')), '');

    IF NOT v_ov_ack
       AND v_ov_level IS NULL
       AND v_ov_presc IS NULL
       AND v_ov_src IS NULL
       AND v_ov_ref IS NULL
       AND v_ov_just IS NULL
    THEN
      v_override_part := '<NULL>';
    ELSE
      v_override_part := pg_catalog.concat_ws(
        '::',
        COALESCE(v_ov_level, '<NULL>'),
        v_ov_ack::text,
        COALESCE(v_ov_presc, '<NULL>'),
        COALESCE(v_ov_src, '<NULL>'),
        COALESCE(v_ov_ref, '<NULL>'),
        COALESCE(v_ov_just, '<NULL>')
      );
    END IF;
  END IF;

  v_refill_part := pg_catalog.concat_ws(
    '|',
    app_security.format_canonical_decimal4(p_estimated_daily_consumption),
    COALESCE(p_estimated_supply_days::text, '<NULL>'),
    COALESCE(pg_catalog.to_char(p_estimated_supply_end_date, 'YYYY-MM-DD'), '<NULL>'),
    app_security.format_canonical_decimal4(p_total_dispensed_analyzed),
    app_security.format_canonical_decimal4(p_estimated_remaining_units),
    COALESCE(p_estimated_days_remaining::text, '<NULL>'),
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_refill_status, '')), ''), '<NULL>'),
    COALESCE(pg_catalog.to_char(p_refill_supply_end_date, 'YYYY-MM-DD'), '<NULL>'),
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_forecast_assumptions, '')), ''), '<NULL>'),
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_uncertainty_note, '')), ''), '<NULL>'),
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_calculation_source, '')), ''), 'provisional_client_unverified'),
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_algorithm_version, '')), ''), 'masar_refill_v1')
  );

  v_canonical_payload := pg_catalog.concat_ws(
    '|',
    p_patient_id::text,
    p_medication_plan_id::text,
    app_security.format_canonical_decimal4(p_dispensed_quantity),
    pg_catalog.lower(v_clean_unit),
    COALESCE(p_package_count::text, '<NULL>'),
    app_security.format_canonical_decimal4(p_package_size),
    COALESCE(NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_batch_number, ''))), ''), '<NULL>'),
    COALESCE(pg_catalog.to_char(p_expiry_date, 'YYYY-MM-DD'), '<NULL>'),
    pg_catalog.to_char(p_dispensing_date, 'YYYY-MM-DD'),
    COALESCE(p_is_partial_fill, false)::text,
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_notes, '')), ''), '<NULL>'),
    p_expected_regimen_version_number::text,
    v_override_part,
    v_refill_part
  );
  v_server_payload_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_canonical_payload, 'UTF8'), 'sha256'),
    'hex'
  );

  -- Shadow-audit comparison only: compare optional `p_client_payload_hash` against server digest
  -- without enforcing strict rejection until live PostgreSQL parity telemetry is 100% verified.
  IF v_clean_client_hash IS NOT NULL THEN
    v_client_hash_matched := (v_clean_client_hash = v_server_payload_hash);
  END IF;

  -- Concurrent retry / duplicate serialization per (pharmacy_id, client_event_uuid)
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_staff.pharmacy_id::text || ':' || p_client_event_uuid::text, 0)
  );

  SELECT * INTO v_existing_dispense
  FROM public.dispensing_events de
  WHERE de.pharmacy_id = v_staff.pharmacy_id
    AND de.client_event_uuid = p_client_event_uuid
  FOR SHARE;

  IF FOUND THEN
    IF v_existing_dispense.client_payload_hash IS DISTINCT FROM v_server_payload_hash
       OR (
         v_clean_client_hash IS NOT NULL
         AND NULLIF(pg_catalog.lower(COALESCE(v_existing_dispense.calculation_inputs->>'clientPayloadHash', '')), '') IS NOT NULL
         AND v_clean_client_hash <> pg_catalog.lower(v_existing_dispense.calculation_inputs->>'clientPayloadHash')
       )
    THEN
      RAISE EXCEPTION 'Idempotency conflict: client_event_uuid (%) was reused with modified dispensing details.', p_client_event_uuid
        USING ERRCODE = '23514';
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'dispensingEventId', v_existing_dispense.id,
      'idempotentReplay', true,
      'verificationStatus', v_existing_dispense.verification_status,
      'calculationSource', v_existing_dispense.calculation_source
    );
  END IF;

  SELECT * INTO v_patient
  FROM public.patients pt
  WHERE pt.id = p_patient_id
    AND pt.pharmacy_id = v_staff.pharmacy_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient % not found or belongs to another pharmacy.', p_patient_id
      USING ERRCODE = '42501';
  END IF;

  IF v_patient.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot dispense medication for archived patient %.', p_patient_id
      USING ERRCODE = '23514';
  END IF;

  -- Lock plan row FOR UPDATE so concurrent dispensing / regimen edits serialize cleanly
  SELECT * INTO v_plan
  FROM public.patient_medication_plans mp
  WHERE mp.id = p_medication_plan_id
    AND mp.patient_id = p_patient_id
    AND mp.pharmacy_id = v_staff.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Medication plan % not found for patient % in this pharmacy.', p_medication_plan_id, p_patient_id
      USING ERRCODE = '42501';
  END IF;

  IF v_plan.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot dispense against non-active medication plan % (status: %).', p_medication_plan_id, v_plan.status
      USING ERRCODE = '23514';
  END IF;

  IF v_plan.current_version_number <> p_expected_regimen_version_number THEN
    RAISE EXCEPTION 'Regimen version mismatch: expected v%, current v%.',
      p_expected_regimen_version_number, v_plan.current_version_number
      USING ERRCODE = '40001';
  END IF;

  v_allergy_eval := app_security.assess_critical_allergy_conflict(
    v_staff.pharmacy_id,
    p_patient_id,
    v_plan.brand_name,
    v_plan.generic_name,
    v_plan.catalog_id
  );
  v_has_critical := COALESCE((v_allergy_eval->>'hasCriticalConflict')::boolean, false);

  PERFORM app_security.validate_allergy_override_evidence(
    p_allergy_override_evidence,
    v_allergy_eval
  );

  v_freq := COALESCE(v_plan.schedule->>'frequencyType', '');
  v_dose_unit_cat := app_security.normalize_clinical_unit_category(v_plan.dose_unit);
  v_disp_unit_cat := app_security.normalize_clinical_unit_category(v_clean_unit);
  v_units_compatible := (
    v_dose_unit_cat <> ''
    AND v_disp_unit_cat <> ''
    AND v_dose_unit_cat = v_disp_unit_cat
  );

  IF NOT v_units_compatible THEN
    RAISE EXCEPTION 'Dispensed unit (%) is incompatible with prescribed plan unit (%).', v_clean_unit, v_plan.dose_unit
      USING ERRCODE = '23514';
  END IF;

  v_server_daily_rate := app_security.compute_plan_daily_rate(
    v_plan.schedule,
    v_plan.dose_amount,
    v_plan.status
  );

  SELECT COALESCE(pg_catalog.sum(de.dispensed_quantity), 0) + p_dispensed_quantity
    INTO v_auth_total_dispensed
  FROM public.dispensing_events de
  WHERE de.medication_plan_id = p_medication_plan_id
    AND de.pharmacy_id = v_staff.pharmacy_id;

  IF v_freq = 'prn' THEN
    IF p_refill_status <> 'paused_or_prn'
       OR p_estimated_supply_end_date IS NOT NULL
       OR p_refill_supply_end_date IS NOT NULL
    THEN
      RAISE EXCEPTION 'PRN plans must record paused_or_prn refill_status without a depletion date.'
        USING ERRCODE = '23514';
    END IF;
    v_eff_daily_consumption := NULL;
    v_eff_supply_days := NULL;
    v_eff_supply_end_date := NULL;
    v_eff_remaining_units := NULL;
    v_eff_days_remaining := NULL;
    v_eff_refill_supply_end_date := NULL;

  ELSIF v_server_daily_rate IS NULL OR v_server_daily_rate <= 0 THEN
    IF p_refill_status <> 'unable_to_estimate'
       OR p_estimated_supply_end_date IS NOT NULL
       OR p_refill_supply_end_date IS NOT NULL
    THEN
      RAISE EXCEPTION 'Plan without deterministic daily consumption rate must record unable_to_estimate without a depletion date.'
        USING ERRCODE = '23514';
    END IF;
    v_eff_daily_consumption := NULL;
    v_eff_supply_days := NULL;
    v_eff_supply_end_date := NULL;
    v_eff_remaining_units := NULL;
    v_eff_days_remaining := NULL;
    v_eff_refill_supply_end_date := NULL;

  ELSE
    IF p_estimated_daily_consumption IS NULL
       OR pg_catalog.abs(p_estimated_daily_consumption - v_server_daily_rate) > GREATEST(0.05, v_server_daily_rate * 0.05)
    THEN
      RAISE EXCEPTION 'Client estimated_daily_consumption (%) deviates from authoritative schedule daily rate (%).',
        p_estimated_daily_consumption, v_server_daily_rate
        USING ERRCODE = '23514';
    END IF;

    IF p_total_dispensed_analyzed IS NOT NULL
       AND pg_catalog.abs(p_total_dispensed_analyzed - v_auth_total_dispensed) > 0.01
    THEN
      RAISE EXCEPTION 'Client total_dispensed_analyzed (%) does not match authoritative cumulative ledger sum (%).',
        p_total_dispensed_analyzed, v_auth_total_dispensed
        USING ERRCODE = '23514';
    END IF;

    IF p_estimated_remaining_units IS NOT NULL
       AND p_estimated_remaining_units > (v_auth_total_dispensed + 0.01)
    THEN
      RAISE EXCEPTION 'Client estimated_remaining_units (%) exceeds authoritative total dispensed (%).',
        p_estimated_remaining_units, v_auth_total_dispensed
        USING ERRCODE = '23514';
    END IF;

    IF p_estimated_supply_days IS NOT NULL AND p_estimated_supply_end_date IS NOT NULL THEN
      IF pg_catalog.abs((p_estimated_supply_end_date - (p_dispensing_date + p_estimated_supply_days))) > 1 THEN
        RAISE EXCEPTION 'Client estimated_supply_end_date (%) is inconsistent with dispensing_date + estimated_supply_days (%).',
          p_estimated_supply_end_date, (p_dispensing_date + p_estimated_supply_days)
          USING ERRCODE = '23514';
      END IF;
    END IF;

    v_eff_daily_consumption := v_server_daily_rate;
    v_eff_supply_days := p_estimated_supply_days;
    v_eff_supply_end_date := p_estimated_supply_end_date;
    v_eff_remaining_units := p_estimated_remaining_units;
    v_eff_days_remaining := p_estimated_days_remaining;
    v_eff_refill_supply_end_date := p_refill_supply_end_date;
  END IF;

  v_calc_source := 'provisional_client_unverified';
  v_verif_status := 'provisional_unverified';

  v_eff_assumptions := COALESCE(
    NULLIF(pg_catalog.btrim(COALESCE(p_forecast_assumptions, '')), ''),
    'Provisional client schedule projection (unit compatibility & daily rate bounds server-validated)'
  );
  v_eff_uncertainty := COALESCE(
    NULLIF(pg_catalog.btrim(COALESCE(p_uncertainty_note, '')), ''),
    'Provisional client refill estimate (server validated units, daily rate bounds, and cumulative ledger sum)'
  );

  v_inputs_snapshot := COALESCE(p_calculation_inputs, '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'rpcVersion', 'v2',
    'serverValidatedAt', pg_catalog.now(),
    'serverDailyRate', v_server_daily_rate,
    'authoritativeTotalDispensed', v_auth_total_dispensed,
    'planStatus', v_plan.status,
    'regimenVersionNumber', v_plan.current_version_number,
    'expectedRegimenVersionNumber', p_expected_regimen_version_number,
    'prescribedDoseUnit', v_plan.dose_unit,
    'dispensedUnit', v_clean_unit,
    'unitsCompatible', v_units_compatible,
    'serverPayloadHash', v_server_payload_hash,
    'clientHashProvided', (v_clean_client_hash IS NOT NULL),
    'clientServerHashMatched', v_client_hash_matched,
    'clientHashEnforcementMode', 'shadow_audit_only',
    'clientSubmissionId', p_client_event_uuid,
    'serverCriticalAllergyDetected', v_has_critical,
    'allergyEvaluation', v_allergy_eval,
    'requestedCalculationSource', COALESCE(p_calculation_source, 'provisional_client_unverified')
  );
  IF v_clean_client_hash IS NOT NULL THEN
    v_inputs_snapshot := v_inputs_snapshot || pg_catalog.jsonb_build_object(
      'clientPayloadHash', v_clean_client_hash,
      'clientPayloadHashMismatch', (v_client_hash_matched IS FALSE)
    );
  END IF;
  IF p_allergy_override_evidence IS NOT NULL THEN
    v_inputs_snapshot := v_inputs_snapshot || pg_catalog.jsonb_build_object(
      'allergyOverride', p_allergy_override_evidence
    );
  END IF;

  INSERT INTO public.dispensing_events (
    pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
    dispensed_quantity, quantity_unit, package_count, package_size,
    batch_number, expiry_date, dispensing_date,
    dispensed_by_staff_id, dispensed_by_staff_name, notes,
    estimated_daily_consumption, estimated_supply_days, estimated_supply_end_date,
    forecast_assumptions, is_partial_fill,
    calculation_source, verification_status, algorithm_version, calculation_inputs,
    client_event_uuid, client_payload_hash
  )
  VALUES (
    v_staff.pharmacy_id,
    p_patient_id,
    p_medication_plan_id,
    v_plan.current_version_number,
    p_dispensed_quantity,
    v_clean_unit,
    p_package_count,
    p_package_size,
    NULLIF(pg_catalog.btrim(COALESCE(p_batch_number, '')), ''),
    p_expiry_date,
    p_dispensing_date,
    v_staff.staff_id,
    v_staff.full_name,
    NULLIF(pg_catalog.btrim(COALESCE(p_notes, '')), ''),
    v_eff_daily_consumption,
    v_eff_supply_days,
    v_eff_supply_end_date,
    v_eff_assumptions,
    COALESCE(p_is_partial_fill, false),
    v_calc_source,
    v_verif_status,
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_algorithm_version, '')), ''), 'masar_refill_v1'),
    v_inputs_snapshot,
    p_client_event_uuid,
    v_server_payload_hash
  )
  RETURNING id INTO v_dispense_id;

  INSERT INTO public.refill_assessments (
    pharmacy_id, patient_id, medication_plan_id, last_dispensing_event_id,
    last_dispensed_date, last_dispensed_quantity, total_dispensed_analyzed,
    quantity_unit, estimated_daily_consumption, estimated_remaining_units,
    estimated_days_remaining, estimated_supply_end_date,
    refill_status, uncertainty_note, calculated_at,
    calculation_source, verification_status, algorithm_version, calculation_inputs
  )
  VALUES (
    v_staff.pharmacy_id,
    p_patient_id,
    p_medication_plan_id,
    v_dispense_id,
    p_dispensing_date,
    p_dispensed_quantity,
    v_auth_total_dispensed,
    v_clean_unit,
    v_eff_daily_consumption,
    v_eff_remaining_units,
    v_eff_days_remaining,
    v_eff_refill_supply_end_date,
    p_refill_status,
    v_eff_uncertainty,
    pg_catalog.now(),
    v_calc_source,
    v_verif_status,
    COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_algorithm_version, '')), ''), 'masar_refill_v1'),
    v_inputs_snapshot
  )
  ON CONFLICT (medication_plan_id) DO UPDATE
    SET last_dispensing_event_id = EXCLUDED.last_dispensing_event_id,
        last_dispensed_date = EXCLUDED.last_dispensed_date,
        last_dispensed_quantity = EXCLUDED.last_dispensed_quantity,
        total_dispensed_analyzed = EXCLUDED.total_dispensed_analyzed,
        quantity_unit = EXCLUDED.quantity_unit,
        estimated_daily_consumption = EXCLUDED.estimated_daily_consumption,
        estimated_remaining_units = EXCLUDED.estimated_remaining_units,
        estimated_days_remaining = EXCLUDED.estimated_days_remaining,
        estimated_supply_end_date = EXCLUDED.estimated_supply_end_date,
        refill_status = EXCLUDED.refill_status,
        uncertainty_note = EXCLUDED.uncertainty_note,
        calculated_at = pg_catalog.now(),
        calculation_source = EXCLUDED.calculation_source,
        verification_status = EXCLUDED.verification_status,
        algorithm_version = EXCLUDED.algorithm_version,
        calculation_inputs = EXCLUDED.calculation_inputs;

  v_audit_meta := pg_catalog.jsonb_build_object(
    'rpcVersion', 'v2',
    'patientId', p_patient_id,
    'medicationPlanId', p_medication_plan_id,
    'regimenVersionNumber', v_plan.current_version_number,
    'refillStatus', p_refill_status,
    'calculationSource', v_calc_source,
    'verificationStatus', v_verif_status,
    'authoritativeTotalDispensed', v_auth_total_dispensed,
    'clientEventUuid', p_client_event_uuid,
    'serverPayloadHash', v_server_payload_hash,
    'clientHashProvided', (v_clean_client_hash IS NOT NULL),
    'clientServerHashMatched', v_client_hash_matched,
    'clientHashEnforcementMode', 'shadow_audit_only',
    'serverCriticalAllergyDetected', v_has_critical,
    'allergyEvaluation', v_allergy_eval
  );
  IF v_clean_client_hash IS NOT NULL THEN
    v_audit_meta := v_audit_meta || pg_catalog.jsonb_build_object(
      'clientPayloadHash', v_clean_client_hash,
      'clientPayloadHashMismatch', (v_client_hash_matched IS FALSE)
    );
  END IF;
  IF p_allergy_override_evidence IS NOT NULL THEN
    v_audit_meta := v_audit_meta || pg_catalog.jsonb_build_object('allergyOverride', p_allergy_override_evidence);
  END IF;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'DISPENSE_RECORDED',
    'dispensing',
    v_dispense_id,
    'صرف ' || p_dispensed_quantity || ' ' || v_clean_unit || ' من ' || v_plan.brand_name || ' للمراجع ' || v_patient.full_name,
    'Dispensed ' || p_dispensed_quantity || ' ' || v_clean_unit || ' of ' || v_plan.brand_name || ' to ' || v_patient.full_name,
    v_audit_meta
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dispensingEventId', v_dispense_id,
    'idempotentReplay', false,
    'verificationStatus', v_verif_status,
    'calculationSource', v_calc_source,
    'authoritativeTotalDispensed', v_auth_total_dispensed,
    'clientHashProvided', (v_clean_client_hash IS NOT NULL),
    'clientServerHashMatched', v_client_hash_matched,
    'clientHashEnforcementMode', 'shadow_audit_only'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_dispensing_with_refill_v2(
  uuid, uuid, numeric, text, integer, numeric, text, date, date, boolean, text,
  numeric, integer, date, text, numeric, numeric, integer, text, date, text,
  text, text, jsonb, integer, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_dispensing_with_refill_v2(
  uuid, uuid, numeric, text, integer, numeric, text, date, date, boolean, text,
  numeric, integer, date, text, numeric, numeric, integer, text, date, text,
  text, text, jsonb, integer, uuid, text, jsonb
) TO authenticated;

COMMIT;
