-- ============================================================================
-- MASAR Care — Stage 2B Additive Migration 0004 (DRAFT ONLY — DO NOT EXECUTE)
-- Scope: Remediate double-encoded UTF-8 Arabic literals in SQL functions created
--        by migrations 0002 and 0003 (14 functions total), including app_security.normalize_clinical_unit_category
--        and audit_logs summary generation in RPCs and triggers.
-- Rules:
--   - Additive CREATE OR REPLACE FUNCTION only (preserves exact signatures,
--     return types, SECURITY DEFINER, SET search_path, RLS checks, and grants).
--   - Does NOT alter or recreate any tables.
--   - Does NOT modify historical migrations 0001, 0002, or 0003.
--   - Does NOT rewrite or modify existing patient, pharmacy, staff, dispensing,
--     or historical audit_logs rows.
-- STATUS: DRAFT ONLY — AWAITING EXPLICIT APPROVAL BEFORE EXECUTION
-- ============================================================================

BEGIN;

-- 1. app_security.normalize_clinical_unit_category(text)
CREATE OR REPLACE FUNCTION app_security.normalize_clinical_unit_category(p_unit text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_u text;
BEGIN
  v_u := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_unit, '')));
  IF v_u IN ('tablet', 'tablets', 'قرص', 'أقراص', 'حبة', 'حبات') THEN
    RETURN 'tablet';
  ELSIF v_u IN ('capsule', 'capsules', 'كبسولة', 'كبسولات') THEN
    RETURN 'capsule';
  ELSIF v_u IN ('ml', 'ملي', 'مل') THEN
    RETURN 'ml';
  ELSIF v_u IN ('puff', 'puffs', 'بخة', 'بخات') THEN
    RETURN 'puff';
  ELSIF v_u IN ('iu', 'unit', 'units', 'وحدة', 'وحدات') THEN
    RETURN 'iu';
  ELSIF v_u IN ('drop', 'drops', 'قطرة', 'قطرات') THEN
    RETURN 'drop';
  ELSIF v_u IN ('sachet', 'sachets', 'كيس', 'أكياس', 'ظرف') THEN
    RETURN 'sachet';
  ELSIF v_u IN ('ampoule', 'vial', 'injection', 'إبرة', 'أمبولة', 'فيال') THEN
    RETURN 'injection_vial';
  END IF;
  RETURN v_u;
END;
$$;

REVOKE ALL ON FUNCTION app_security.normalize_clinical_unit_category(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.normalize_clinical_unit_category(text) TO service_role;

-- 2. public.finalize_first_owner_bootstrap(...)
CREATE OR REPLACE FUNCTION public.finalize_first_owner_bootstrap(
  p_request_id uuid,
  p_owner_user_id uuid,
  p_pharmacy_name_ar text,
  p_pharmacy_name_en text,
  p_city text,
  p_governorate text,
  p_license_number text,
  p_pharmacy_phone text,
  p_owner_full_name text,
  p_owner_phone text,
  p_syndicate_license text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_state       public.bootstrap_state%ROWTYPE;
  v_pharmacy_id uuid;
BEGIN
  IF p_request_id IS NULL OR p_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'Request id and owner auth user id are required for bootstrap finalization.'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('masar_care_first_owner_bootstrap', 0)
  );

  IF EXISTS (SELECT 1 FROM public.pharmacy_staff)
     OR EXISTS (SELECT 1 FROM public.pharmacies)
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'BOOTSTRAP_ALREADY_COMPLETED'
    );
  END IF;

  SELECT * INTO v_state
  FROM public.bootstrap_state bs
  WHERE bs.singleton_key = true
  FOR UPDATE;

  IF FOUND AND v_state.status = 'completed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'BOOTSTRAP_ALREADY_COMPLETED'
    );
  END IF;

  IF FOUND AND v_state.status = 'failed_needs_reconciliation' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'BOOTSTRAP_NEEDS_RECONCILIATION'
    );
  END IF;

  IF NOT FOUND
     OR v_state.status <> 'claimed'
     OR v_state.claimed_by_request_id IS DISTINCT FROM p_request_id
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'BOOTSTRAP_CLAIM_MISMATCH'
    );
  END IF;

  INSERT INTO public.pharmacies (
    name_ar, name_en, city, governorate, license_number, phone, timezone, is_active
  )
  VALUES (
    pg_catalog.btrim(p_pharmacy_name_ar),
    pg_catalog.btrim(p_pharmacy_name_en),
    pg_catalog.btrim(p_city),
    pg_catalog.btrim(p_governorate),
    pg_catalog.btrim(p_license_number),
    pg_catalog.btrim(p_pharmacy_phone),
    'Asia/Baghdad',
    true
  )
  RETURNING id INTO v_pharmacy_id;

  INSERT INTO public.pharmacy_staff (
    id, pharmacy_id, full_name, role, syndicate_license, phone, is_active, created_by_user_id
  )
  VALUES (
    p_owner_user_id,
    v_pharmacy_id,
    pg_catalog.btrim(p_owner_full_name),
    'pharmacy_owner',
    NULLIF(pg_catalog.btrim(COALESCE(p_syndicate_license, '')), ''),
    pg_catalog.btrim(p_owner_phone),
    true,
    NULL
  );

  UPDATE public.bootstrap_state
     SET status = 'completed',
         completed_at = pg_catalog.now(),
         claim_expires_at = NULL,
         pharmacy_id = v_pharmacy_id,
         owner_user_id = p_owner_user_id,
         orphan_auth_user_id = NULL,
         last_error = NULL,
         updated_at = pg_catalog.now()
   WHERE singleton_key = true;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_pharmacy_id,
    NULL,
    'Platform Administrator Bootstrap',
    'platform_owner',
    'BOOTSTRAP_OWNER_PROVISIONED',
    'staff',
    p_owner_user_id,
    'تمت تهيئة الصيدلية الأولى وحساب مالك الصيدلية لمرة واحدة',
    'Completed one-time initial pharmacy and pharmacy_owner bootstrap',
    pg_catalog.jsonb_build_object(
      'pharmacyId', v_pharmacy_id,
      'ownerUserId', p_owner_user_id,
      'requestId', p_request_id,
      'role', 'pharmacy_owner'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'pharmacyId', v_pharmacy_id,
    'ownerUserId', p_owner_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_first_owner_bootstrap(
  uuid, uuid, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_first_owner_bootstrap(
  uuid, uuid, text, text, text, text, text, text, text, text, text
) TO service_role;

-- 3. public.provision_pharmacy_staff_by_owner(...)
CREATE OR REPLACE FUNCTION public.provision_pharmacy_staff_by_owner(
  p_owner_user_id uuid,
  p_new_user_id uuid,
  p_full_name text,
  p_role text,
  p_phone text,
  p_syndicate_license text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_owner       public.pharmacy_staff%ROWTYPE;
  v_pharmacy    public.pharmacies%ROWTYPE;
  v_req         public.staff_provisioning_requests%ROWTYPE;
  v_clean_name  text;
  v_clean_phone text;
  v_clean_syn   text;
BEGIN
  -- Stage 2B.2A.3: Reject claimless (p_request_id IS NULL) normal provisioning!
  IF p_owner_user_id IS NULL OR p_new_user_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Owner, new staff user id, and valid claim request_id are required; claimless provisioning is disabled.'
      USING ERRCODE = '23514';
  END IF;

  IF p_role IS DISTINCT FROM 'authorized_pharmacist' THEN
    RAISE EXCEPTION 'Owner staff provisioning is restricted to authorized_pharmacist; pharmacy_owner delegation is not enabled.'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_owner
  FROM public.pharmacy_staff ps
  WHERE ps.id = p_owner_user_id
  FOR SHARE;

  IF NOT FOUND OR v_owner.is_active IS DISTINCT FROM true OR v_owner.role <> 'pharmacy_owner' THEN
    RAISE EXCEPTION 'Caller % is not an active pharmacy_owner.', p_owner_user_id
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_pharmacy
  FROM public.pharmacies ph
  WHERE ph.id = v_owner.pharmacy_id
  FOR SHARE;

  IF NOT FOUND OR v_pharmacy.is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Pharmacy % is inactive or missing.', v_owner.pharmacy_id
      USING ERRCODE = '42501';
  END IF;

  v_clean_name := pg_catalog.btrim(COALESCE(p_full_name, ''));
  v_clean_phone := pg_catalog.btrim(COALESCE(p_phone, ''));
  v_clean_syn := NULLIF(pg_catalog.btrim(COALESCE(p_syndicate_license, '')), '');

  SELECT * INTO v_req
  FROM public.staff_provisioning_requests spr
  WHERE spr.request_id = p_request_id
    AND spr.pharmacy_id = v_owner.pharmacy_id
    AND spr.owner_user_id = v_owner.id
  FOR UPDATE;

  IF NOT FOUND OR v_req.status <> 'claimed' THEN
    RAISE EXCEPTION 'Staff provisioning claim % is missing or not in claimed state.', p_request_id
      USING ERRCODE = '23514';
  END IF;

  IF v_req.target_phone IS DISTINCT FROM v_clean_phone
     OR v_req.target_role IS DISTINCT FROM 'authorized_pharmacist'
  THEN
    RAISE EXCEPTION 'Staff provisioning claim % does not match canonical target phone or role.', p_request_id
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.pharmacy_staff (
    id, pharmacy_id, full_name, role, syndicate_license, phone, is_active, created_by_user_id
  )
  VALUES (
    p_new_user_id,
    v_owner.pharmacy_id,
    v_clean_name,
    'authorized_pharmacist',
    v_clean_syn,
    v_clean_phone,
    true,
    v_owner.id
  );

  UPDATE public.staff_provisioning_requests
     SET status = 'completed',
         staff_user_id = p_new_user_id,
         claim_expires_at = NULL,
         orphan_auth_user_id = NULL,
         last_error = NULL,
         completed_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE id = v_req.id;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_owner.pharmacy_id,
    v_owner.id,
    v_owner.full_name,
    v_owner.role,
    'STAFF_PROVISIONED',
    'staff',
    p_new_user_id,
    'إضافة صيدلي مخوّل جديد: ' || v_clean_name || ' (authorized_pharmacist)',
    'Provisioned new authorized_pharmacist: ' || v_clean_name,
    pg_catalog.jsonb_build_object(
      'staffId', p_new_user_id,
      'role', 'authorized_pharmacist',
      'provisionedByOwnerId', v_owner.id,
      'requestId', p_request_id,
      'requestFingerprint', v_req.request_fingerprint
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'staffId', p_new_user_id,
    'pharmacyId', v_owner.pharmacy_id,
    'role', 'authorized_pharmacist'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.provision_pharmacy_staff_by_owner(
  uuid, uuid, text, text, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_pharmacy_staff_by_owner(
  uuid, uuid, text, text, text, text, uuid
) TO service_role;

-- 4. public.create_patient_with_clinical_tags(...)
CREATE OR REPLACE FUNCTION public.create_patient_with_clinical_tags(
  p_patient_code text,
  p_full_name text,
  p_phone text,
  p_phone_owner_type text DEFAULT 'self',
  p_caregiver_name text DEFAULT NULL,
  p_date_of_birth date DEFAULT NULL,
  p_sex text DEFAULT NULL,
  p_contact_preference text DEFAULT 'whatsapp',
  p_clinical_notes text DEFAULT '',
  p_registration_date date DEFAULT (pg_catalog.now() AT TIME ZONE 'Asia/Baghdad')::date,
  p_chronic_conditions jsonb DEFAULT '[]'::jsonb,
  p_allergies jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff       record;
  v_patient_id  uuid;
  v_cond        text;
  v_allergy     jsonb;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  IF p_date_of_birth IS NULL THEN
    RAISE EXCEPTION 'Patient date_of_birth is required.'
      USING ERRCODE = '23514';
  END IF;

  IF p_chronic_conditions IS NOT NULL AND pg_catalog.jsonb_typeof(p_chronic_conditions) <> 'array' THEN
    RAISE EXCEPTION 'p_chronic_conditions must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  IF p_allergies IS NOT NULL AND pg_catalog.jsonb_typeof(p_allergies) <> 'array' THEN
    RAISE EXCEPTION 'p_allergies must be a JSON array.'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.patients (
    pharmacy_id, patient_code, full_name, phone, phone_owner_type,
    caregiver_name, date_of_birth, sex, contact_preference,
    clinical_notes, registration_date, status, created_by_staff_id
  )
  VALUES (
    v_staff.pharmacy_id,
    pg_catalog.btrim(p_patient_code),
    pg_catalog.btrim(p_full_name),
    pg_catalog.btrim(p_phone),
    COALESCE(NULLIF(pg_catalog.btrim(p_phone_owner_type), ''), 'self'),
    NULLIF(pg_catalog.btrim(COALESCE(p_caregiver_name, '')), ''),
    p_date_of_birth,
    p_sex,
    COALESCE(NULLIF(pg_catalog.btrim(p_contact_preference), ''), 'whatsapp'),
    COALESCE(p_clinical_notes, ''),
    COALESCE(p_registration_date, (pg_catalog.now() AT TIME ZONE 'Asia/Baghdad')::date),
    'active',
    v_staff.staff_id
  )
  RETURNING id INTO v_patient_id;

  FOR v_cond IN
    SELECT DISTINCT pg_catalog.btrim(val)
    FROM pg_catalog.jsonb_array_elements_text(COALESCE(p_chronic_conditions, '[]'::jsonb)) AS t(val)
    WHERE pg_catalog.char_length(pg_catalog.btrim(val)) >= 2
  LOOP
    INSERT INTO public.patient_conditions (pharmacy_id, patient_id, condition_name, status)
    VALUES (v_staff.pharmacy_id, v_patient_id, v_cond, 'active')
    ON CONFLICT (patient_id, condition_name) DO UPDATE
      SET status = 'active',
          removed_at = NULL,
          removed_by_staff_id = NULL,
          removal_reason = NULL;
  END LOOP;

  FOR v_allergy IN
    SELECT elem
    FROM pg_catalog.jsonb_array_elements(COALESCE(p_allergies, '[]'::jsonb)) AS t(elem)
  LOOP
    IF pg_catalog.char_length(pg_catalog.btrim(COALESCE(v_allergy->>'substance', ''))) >= 2 THEN
      INSERT INTO public.patient_allergies (
        pharmacy_id, patient_id, substance, severity, reaction, status
      )
      VALUES (
        v_staff.pharmacy_id,
        v_patient_id,
        pg_catalog.btrim(v_allergy->>'substance'),
        COALESCE(NULLIF(pg_catalog.btrim(v_allergy->>'severity'), ''), 'moderate'),
        NULLIF(pg_catalog.btrim(COALESCE(v_allergy->>'reaction', '')), ''),
        'active'
      )
      ON CONFLICT (patient_id, substance) DO UPDATE
        SET severity = EXCLUDED.severity,
            reaction = EXCLUDED.reaction,
            status = 'active',
            removed_at = NULL,
            removed_by_staff_id = NULL,
            removal_reason = NULL;
    END IF;
  END LOOP;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'PATIENT_REGISTERED',
    'patient',
    v_patient_id,
    'تسجيل المراجع الجديد ' || pg_catalog.btrim(p_full_name) || ' (' || pg_catalog.btrim(p_patient_code) || ')',
    'Registered new patient ' || pg_catalog.btrim(p_full_name) || ' (' || pg_catalog.btrim(p_patient_code) || ')',
    pg_catalog.jsonb_build_object('patientCode', pg_catalog.btrim(p_patient_code))
  );

  RETURN jsonb_build_object(
    'ok', true,
    'patientId', v_patient_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_patient_with_clinical_tags(
  text, text, text, text, text, date, text, text, text, date, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_patient_with_clinical_tags(
  text, text, text, text, text, date, text, text, text, date, jsonb, jsonb
) TO authenticated;

-- 5. public.update_patient_with_clinical_tags(...)
CREATE OR REPLACE FUNCTION public.update_patient_with_clinical_tags(
  p_patient_id uuid,
  p_patch jsonb DEFAULT '{}'::jsonb,
  p_chronic_conditions jsonb DEFAULT NULL,
  p_allergies jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff            record;
  v_patient          public.patients%ROWTYPE;
  v_cond             text;
  v_allergy          jsonb;
  v_kept_conds       text[] := '{}'::text[];
  v_kept_subs        text[] := '{}'::text[];
  v_prev_conditions  jsonb;
  v_curr_conditions  jsonb;
  v_prev_allergies   jsonb;
  v_curr_allergies   jsonb;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  IF p_patch IS NOT NULL AND pg_catalog.jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'p_patch must be a JSON object.' USING ERRCODE = '22023';
  END IF;

  IF p_chronic_conditions IS NOT NULL AND pg_catalog.jsonb_typeof(p_chronic_conditions) <> 'array' THEN
    RAISE EXCEPTION 'p_chronic_conditions must be a JSON array.' USING ERRCODE = '22023';
  END IF;

  IF p_allergies IS NOT NULL AND pg_catalog.jsonb_typeof(p_allergies) <> 'array' THEN
    RAISE EXCEPTION 'p_allergies must be a JSON array.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_patient
  FROM public.patients pt
  WHERE pt.id = p_patient_id
    AND pt.pharmacy_id = v_staff.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient % not found or belongs to another pharmacy.', p_patient_id
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(pc.condition_name ORDER BY pc.condition_name), '[]'::jsonb)
    INTO v_prev_conditions
  FROM public.patient_conditions pc
  WHERE pc.patient_id = p_patient_id
    AND pc.pharmacy_id = v_staff.pharmacy_id
    AND pc.status = 'active';

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'substance', pa.substance,
        'severity', pa.severity,
        'reaction', pa.reaction
      )
      ORDER BY pa.substance
    ),
    '[]'::jsonb
  )
    INTO v_prev_allergies
  FROM public.patient_allergies pa
  WHERE pa.patient_id = p_patient_id
    AND pa.pharmacy_id = v_staff.pharmacy_id
    AND pa.status = 'active';

  UPDATE public.patients
     SET full_name = CASE WHEN p_patch ? 'full_name' THEN COALESCE(pg_catalog.btrim(p_patch->>'full_name'), '') ELSE full_name END,
         phone = CASE WHEN p_patch ? 'phone' THEN COALESCE(pg_catalog.btrim(p_patch->>'phone'), '') ELSE phone END,
         phone_owner_type = CASE WHEN p_patch ? 'phone_owner_type' THEN COALESCE(p_patch->>'phone_owner_type', '') ELSE phone_owner_type END,
         caregiver_name = CASE WHEN p_patch ? 'caregiver_name' THEN NULLIF(pg_catalog.btrim(COALESCE(p_patch->>'caregiver_name', '')), '') ELSE caregiver_name END,
         date_of_birth = CASE WHEN p_patch ? 'date_of_birth' THEN NULLIF(pg_catalog.btrim(COALESCE(p_patch->>'date_of_birth', '')), '')::date ELSE date_of_birth END,
         sex = CASE WHEN p_patch ? 'sex' THEN COALESCE(p_patch->>'sex', '') ELSE sex END,
         contact_preference = CASE WHEN p_patch ? 'contact_preference' THEN COALESCE(p_patch->>'contact_preference', '') ELSE contact_preference END,
         clinical_notes = CASE WHEN p_patch ? 'clinical_notes' THEN COALESCE(p_patch->>'clinical_notes', '') ELSE clinical_notes END,
         updated_at = pg_catalog.now()
   WHERE id = p_patient_id
     AND pharmacy_id = v_staff.pharmacy_id
   RETURNING * INTO v_patient;

  IF p_chronic_conditions IS NOT NULL THEN
    FOR v_cond IN
      SELECT DISTINCT pg_catalog.btrim(val)
      FROM pg_catalog.jsonb_array_elements_text(p_chronic_conditions) AS t(val)
      WHERE pg_catalog.char_length(pg_catalog.btrim(val)) >= 2
    LOOP
      v_kept_conds := pg_catalog.array_append(v_kept_conds, v_cond);
      INSERT INTO public.patient_conditions (pharmacy_id, patient_id, condition_name, status)
      VALUES (v_staff.pharmacy_id, p_patient_id, v_cond, 'active')
      ON CONFLICT (patient_id, condition_name) DO UPDATE
        SET status = 'active',
            removed_at = NULL,
            removed_by_staff_id = NULL,
            removal_reason = NULL;
    END LOOP;

    UPDATE public.patient_conditions pc
       SET status = 'inactive',
           removed_at = pg_catalog.now(),
           removed_by_staff_id = v_staff.staff_id,
           removal_reason = 'Deactivated during pharmacist patient profile update'
     WHERE pc.patient_id = p_patient_id
       AND pc.pharmacy_id = v_staff.pharmacy_id
       AND pc.status = 'active'
       AND NOT (pc.condition_name = ANY(v_kept_conds));
  END IF;

  IF p_allergies IS NOT NULL THEN
    FOR v_allergy IN
      SELECT elem FROM pg_catalog.jsonb_array_elements(p_allergies) AS t(elem)
    LOOP
      IF pg_catalog.char_length(pg_catalog.btrim(COALESCE(v_allergy->>'substance', ''))) >= 2 THEN
        v_kept_subs := pg_catalog.array_append(v_kept_subs, pg_catalog.btrim(v_allergy->>'substance'));
        INSERT INTO public.patient_allergies (
          pharmacy_id, patient_id, substance, severity, reaction, status
        )
        VALUES (
          v_staff.pharmacy_id,
          p_patient_id,
          pg_catalog.btrim(v_allergy->>'substance'),
          COALESCE(NULLIF(pg_catalog.btrim(v_allergy->>'severity'), ''), 'moderate'),
          NULLIF(pg_catalog.btrim(COALESCE(v_allergy->>'reaction', '')), ''),
          'active'
        )
        ON CONFLICT (patient_id, substance) DO UPDATE
          SET severity = EXCLUDED.severity,
              reaction = EXCLUDED.reaction,
              status = 'active',
              removed_at = NULL,
              removed_by_staff_id = NULL,
              removal_reason = NULL;
      END IF;
    END LOOP;

    UPDATE public.patient_allergies pa
       SET status = 'inactive',
           removed_at = pg_catalog.now(),
           removed_by_staff_id = v_staff.staff_id,
           removal_reason = 'Deactivated during pharmacist patient profile update'
     WHERE pa.patient_id = p_patient_id
       AND pa.pharmacy_id = v_staff.pharmacy_id
       AND pa.status = 'active'
       AND NOT (pa.substance = ANY(v_kept_subs));
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(pc.condition_name ORDER BY pc.condition_name), '[]'::jsonb)
    INTO v_curr_conditions
  FROM public.patient_conditions pc
  WHERE pc.patient_id = p_patient_id
    AND pc.pharmacy_id = v_staff.pharmacy_id
    AND pc.status = 'active';

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'substance', pa.substance,
        'severity', pa.severity,
        'reaction', pa.reaction
      )
      ORDER BY pa.substance
    ),
    '[]'::jsonb
  )
    INTO v_curr_allergies
  FROM public.patient_allergies pa
  WHERE pa.patient_id = p_patient_id
    AND pa.pharmacy_id = v_staff.pharmacy_id
    AND pa.status = 'active';

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_staff.pharmacy_id,
    v_staff.staff_id,
    v_staff.full_name,
    v_staff.role,
    'PATIENT_UPDATED',
    'patient',
    p_patient_id,
    'تحديث بيانات المراجع ' || v_patient.full_name || ' مع حفظ سجل الحساسية والحالات',
    'Updated patient profile for ' || v_patient.full_name || ' (clinical tag history preserved)',
    pg_catalog.jsonb_build_object(
      'patientId', p_patient_id,
      'conditionsUpdated', (p_chronic_conditions IS NOT NULL),
      'allergiesUpdated', (p_allergies IS NOT NULL),
      'previousConditions', v_prev_conditions,
      'currentConditions', v_curr_conditions,
      'previousAllergies', v_prev_allergies,
      'currentAllergies', v_curr_allergies
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'patientId', p_patient_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_patient_with_clinical_tags(
  uuid, jsonb, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_patient_with_clinical_tags(
  uuid, jsonb, jsonb, jsonb
) TO authenticated;

-- 6. public.create_medication_plan_with_version(...)
CREATE OR REPLACE FUNCTION public.create_medication_plan_with_version(
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
  p_schedule jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff   record;
  v_patient public.patients%ROWTYPE;
  v_plan_id uuid;
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

  IF p_schedule IS NULL OR pg_catalog.jsonb_typeof(p_schedule) <> 'object'
     OR COALESCE(p_schedule->>'timezone', '') <> 'Asia/Baghdad'
     OR COALESCE(p_schedule->>'frequencyType', '') NOT IN ('daily', 'interval', 'weekdays', 'cyclic', 'variable', 'prn')
  THEN
    RAISE EXCEPTION 'Invalid schedule structure: Asia/Baghdad timezone and valid frequencyType required.'
      USING ERRCODE = '23514';
  END IF;

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
    pg_catalog.jsonb_build_object('patientId', p_patient_id, 'versionNumber', 1)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'planId', v_plan_id,
    'versionNumber', 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_medication_plan_with_version(
  uuid, uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_medication_plan_with_version(
  uuid, uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb
) TO authenticated;

-- 7. public.update_medication_plan_version(...)
CREATE OR REPLACE FUNCTION public.update_medication_plan_version(
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
  v_open_version public.regimen_versions%ROWTYPE;
  v_next_ver     integer;
  v_eff_date     date;
  v_clean_reason text;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  v_clean_reason := pg_catalog.btrim(COALESCE(p_change_reason, ''));
  IF pg_catalog.char_length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'A regimen change reason of at least 3 characters is required.'
      USING ERRCODE = '23514';
  END IF;

  IF p_schedule IS NULL OR pg_catalog.jsonb_typeof(p_schedule) <> 'object'
     OR COALESCE(p_schedule->>'timezone', '') <> 'Asia/Baghdad'
     OR COALESCE(p_schedule->>'frequencyType', '') NOT IN ('daily', 'interval', 'weekdays', 'cyclic', 'variable', 'prn')
  THEN
    RAISE EXCEPTION 'Invalid schedule structure: Asia/Baghdad timezone and valid frequencyType required.'
      USING ERRCODE = '23514';
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
    pg_catalog.jsonb_build_object('versionNumber', v_next_ver, 'effectiveDate', v_eff_date, 'reason', v_clean_reason)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'planId', p_plan_id,
    'versionNumber', v_next_ver
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_medication_plan_version(
  uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, text, date
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_medication_plan_version(
  uuid, text, text, text, text, text, numeric, text, text, text, text, text, date, date, boolean, integer, jsonb, text, date
) TO authenticated;

-- 8. public.change_medication_plan_status(...)
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

-- 9. public.record_dispensing_with_refill(...)
CREATE OR REPLACE FUNCTION public.record_dispensing_with_refill(
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
  p_calculation_source text DEFAULT 'provisional_client_unverified',
  p_algorithm_version text DEFAULT 'masar_refill_v1',
  p_calculation_inputs jsonb DEFAULT '{}'::jsonb
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
  v_dispense_id                uuid;
  v_clean_unit                 text;
  v_dose_unit_cat              text;
  v_disp_unit_cat              text;
  v_units_compatible           boolean;
  v_server_daily_rate          numeric;
  v_auth_total_dispensed       numeric;
  v_freq                       text;
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
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  IF p_dispensed_quantity IS NULL OR p_dispensed_quantity <= 0 OR p_dispensed_quantity > 100000 THEN
    RAISE EXCEPTION 'Dispensed quantity must be between 0 and 100000.' USING ERRCODE = '23514';
  END IF;

  IF p_dispensing_date IS NULL THEN
    RAISE EXCEPTION 'Dispensing date is required.' USING ERRCODE = '23514';
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

  IF p_calculation_inputs IS NOT NULL AND pg_catalog.jsonb_typeof(p_calculation_inputs) <> 'object' THEN
    RAISE EXCEPTION 'p_calculation_inputs must be a JSON object.' USING ERRCODE = '22023';
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

  -- Lock plan row FOR UPDATE so concurrent dispensing events for the same plan serialize cleanly
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

  v_freq := COALESCE(v_plan.schedule->>'frequencyType', '');
  v_dose_unit_cat := app_security.normalize_clinical_unit_category(v_plan.dose_unit);
  v_disp_unit_cat := app_security.normalize_clinical_unit_category(v_clean_unit);
  v_units_compatible := (v_dose_unit_cat = v_disp_unit_cat);

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

  IF NOT v_units_compatible THEN
    IF p_refill_status <> 'unable_to_estimate'
       OR p_estimated_supply_days IS NOT NULL
       OR p_estimated_supply_end_date IS NOT NULL
       OR p_refill_supply_end_date IS NOT NULL
    THEN
      RAISE EXCEPTION 'Incompatible dispensed unit (%) vs prescribed dose unit (%) cannot produce an active refill forecast.',
        v_clean_unit, v_plan.dose_unit
        USING ERRCODE = '23514';
    END IF;
    v_eff_daily_consumption := NULL;
    v_eff_supply_days := NULL;
    v_eff_supply_end_date := NULL;
    v_eff_remaining_units := NULL;
    v_eff_days_remaining := NULL;
    v_eff_refill_supply_end_date := NULL;

  ELSIF v_plan.status <> 'active' OR v_freq = 'prn' THEN
    IF p_refill_status <> 'paused_or_prn'
       OR p_estimated_supply_end_date IS NOT NULL
       OR p_refill_supply_end_date IS NOT NULL
    THEN
      RAISE EXCEPTION 'Paused, discontinued, archived, or PRN plans must record paused_or_prn refill_status without a depletion date.'
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

  -- Server always enforces honest provisional provenance when occurrence simulation runs client-side;
  -- client input cannot elevate itself to `server_verified`.
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
    'serverValidatedAt', pg_catalog.now(),
    'serverDailyRate', v_server_daily_rate,
    'authoritativeTotalDispensed', v_auth_total_dispensed,
    'planStatus', v_plan.status,
    'regimenVersionNumber', v_plan.current_version_number,
    'prescribedDoseUnit', v_plan.dose_unit,
    'dispensedUnit', v_clean_unit,
    'unitsCompatible', v_units_compatible,
    'requestedCalculationSource', COALESCE(p_calculation_source, 'provisional_client_unverified')
  );

  INSERT INTO public.dispensing_events (
    pharmacy_id, patient_id, medication_plan_id, regimen_version_number,
    dispensed_quantity, quantity_unit, package_count, package_size,
    batch_number, expiry_date, dispensing_date,
    dispensed_by_staff_id, dispensed_by_staff_name, notes,
    estimated_daily_consumption, estimated_supply_days, estimated_supply_end_date,
    forecast_assumptions, is_partial_fill,
    calculation_source, verification_status, algorithm_version, calculation_inputs
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
    v_inputs_snapshot
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
    pg_catalog.jsonb_build_object(
      'patientId', p_patient_id,
      'medicationPlanId', p_medication_plan_id,
      'regimenVersionNumber', v_plan.current_version_number,
      'refillStatus', p_refill_status,
      'calculationSource', v_calc_source,
      'verificationStatus', v_verif_status,
      'authoritativeTotalDispensed', v_auth_total_dispensed
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dispensingEventId', v_dispense_id,
    'verificationStatus', v_verif_status,
    'calculationSource', v_calc_source,
    'authoritativeTotalDispensed', v_auth_total_dispensed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_dispensing_with_refill(
  uuid, uuid, numeric, text, integer, numeric, text, date, date, boolean, text,
  numeric, integer, date, text, numeric, numeric, integer, text, date, text,
  text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_dispensing_with_refill(
  uuid, uuid, numeric, text, integer, numeric, text, date, date, boolean, text,
  numeric, integer, date, text, numeric, numeric, integer, text, date, text,
  text, text, jsonb
) TO authenticated;

-- 10. public.send_consultation_reply(...)
CREATE OR REPLACE FUNCTION public.send_consultation_reply(
  p_thread_id uuid,
  p_body text,
  p_new_status text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff       record;
  v_thread      public.consultation_threads%ROWTYPE;
  v_clean_body  text;
  v_msg_id      uuid;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  v_clean_body := pg_catalog.btrim(COALESCE(p_body, ''));
  IF pg_catalog.char_length(v_clean_body) < 1 THEN
    RAISE EXCEPTION 'Consultation reply body cannot be empty.' USING ERRCODE = '23514';
  END IF;

  IF p_new_status IS NOT NULL AND p_new_status NOT IN ('open', 'follow_up', 'resolved') THEN
    RAISE EXCEPTION 'Invalid consultation status: %.', p_new_status USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_thread
  FROM public.consultation_threads ct
  WHERE ct.id = p_thread_id
    AND ct.pharmacy_id = v_staff.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consultation thread % not found or belongs to another pharmacy.', p_thread_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.consultation_messages (
    pharmacy_id, thread_id, sender_type, sender_staff_id,
    sender_name, body, approved_by_pharmacist
  )
  VALUES (
    v_staff.pharmacy_id,
    p_thread_id,
    'pharmacist',
    v_staff.staff_id,
    v_staff.full_name,
    v_clean_body,
    true
  )
  RETURNING id INTO v_msg_id;

  UPDATE public.consultation_threads
     SET status = COALESCE(p_new_status, status),
         updated_at = pg_catalog.now()
   WHERE id = p_thread_id
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
    'CONSULTATION_REPLIED',
    'consultation',
    p_thread_id,
    'إرسال رد صيدلاني معتمد على استشارة المراجع',
    'Pharmacist-approved consultation reply sent',
    pg_catalog.jsonb_build_object('messageId', v_msg_id, 'newStatus', COALESCE(p_new_status, v_thread.status))
  );

  RETURN jsonb_build_object(
    'ok', true,
    'threadId', p_thread_id,
    'messageId', v_msg_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.send_consultation_reply(
  uuid, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_consultation_reply(
  uuid, text, text
) TO authenticated;

-- 11. public.revoke_patient_apk_invitation(...)
CREATE OR REPLACE FUNCTION public.revoke_patient_apk_invitation(
  p_patient_id uuid,
  p_reason text DEFAULT 'Pharmacist revoked pending invitation'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_staff        record;
  v_patient      public.patients%ROWTYPE;
  v_inv          public.patient_apk_invitations%ROWTYPE;
  v_clean_reason text;
BEGIN
  SELECT * INTO v_staff FROM app_security.require_active_pharmacist_context();

  v_clean_reason := pg_catalog.btrim(COALESCE(p_reason, ''));
  IF pg_catalog.char_length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Revocation reason must be at least 3 characters.' USING ERRCODE = '23514';
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

  SELECT * INTO v_inv
  FROM public.patient_apk_invitations pai
  WHERE pai.patient_id = p_patient_id
    AND pai.pharmacy_id = v_staff.pharmacy_id
    AND pai.status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVITATION_NOT_PENDING'
    );
  END IF;

  UPDATE public.patient_apk_invitations
     SET status = 'revoked',
         revoked_at = pg_catalog.now()
   WHERE id = v_inv.id
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
    'INVITATION_REVOKED',
    'invitation',
    v_inv.id,
    'إلغاء دعوة تطبيق المريض للمراجع ' || v_patient.full_name,
    'Revoked APK invitation for ' || v_patient.full_name,
    pg_catalog.jsonb_build_object('patientId', p_patient_id, 'reason', v_clean_reason)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'invitationId', v_inv.id,
    'patientId', p_patient_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_patient_apk_invitation(
  uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_patient_apk_invitation(
  uuid, text
) TO authenticated;

-- 12. app_security.write_clinical_audit_log()
CREATE OR REPLACE FUNCTION app_security.write_clinical_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_actor_name  text := 'System';
  v_actor_role  text := 'system';
  v_pharmacy_id uuid;
  v_entity_id   uuid;
  v_entity_type text;
  v_action      text;
  v_summary_ar  text;
  v_summary_en  text;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT ps.full_name, ps.role
      INTO v_actor_name, v_actor_role
    FROM public.pharmacy_staff ps
    WHERE ps.id = v_uid AND ps.is_active = true
    LIMIT 1;

    IF NOT FOUND THEN
      IF EXISTS (SELECT 1 FROM public.patients pt WHERE pt.auth_user_id = v_uid) THEN
        v_actor_name := 'Patient APK User';
        v_actor_role := 'patient_apk_user';
      ELSE
        v_actor_name := 'System';
        v_actor_role := 'system';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'patients' THEN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
      v_pharmacy_id := NEW.pharmacy_id;
      v_entity_id := NEW.id;
      v_entity_type := 'patient';
      IF NEW.status = 'archived' THEN
        v_action := 'PATIENT_ARCHIVED';
        v_summary_ar := 'أرشفة ملف المراجع ' || NEW.full_name || ' مع حفظ السجل';
        v_summary_en := 'Archived patient ' || NEW.full_name || ' (clinical history preserved)';
      ELSE
        v_action := 'PATIENT_RESTORED';
        v_summary_ar := 'إعادة تفعيل ملف المراجع ' || NEW.full_name;
        v_summary_en := 'Restored patient profile for ' || NEW.full_name;
      END IF;
    ELSE
      RETURN NULL;
    END IF;

  ELSIF TG_TABLE_NAME = 'lab_results' AND TG_OP = 'INSERT' THEN
    v_pharmacy_id := NEW.pharmacy_id;
    v_entity_id := NEW.id;
    v_entity_type := 'lab_result';
    v_action := 'LAB_RESULT_RECORDED';
    v_summary_ar := 'تسجيل نتيجة تحليل ' || NEW.test_name || ': ' || NEW.value || ' ' || NEW.unit;
    v_summary_en := 'Recorded lab result ' || NEW.test_name || ': ' || NEW.value || ' ' || NEW.unit;

  ELSIF TG_TABLE_NAME = 'follow_up_tasks' THEN
    v_pharmacy_id := NEW.pharmacy_id;
    v_entity_id := NEW.id;
    v_entity_type := 'follow_up';
    IF TG_OP = 'INSERT' THEN
      v_action := 'FOLLOWUP_CREATED';
      v_summary_ar := 'إنشاء مهمة متابعة بتاريخ ' || NEW.due_date::text;
      v_summary_en := 'Created follow-up task due ' || NEW.due_date::text;
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
      v_action := 'FOLLOWUP_STATUS_UPDATED';
      v_summary_ar := 'تحديث حالة المتابعة إلى (' || NEW.status || ')';
      v_summary_en := 'Updated follow-up task status to ' || NEW.status;
    ELSE
      RETURN NULL;
    END IF;

  ELSIF TG_TABLE_NAME = 'follow_up_contact_logs' AND TG_OP = 'INSERT' THEN
    v_pharmacy_id := NEW.pharmacy_id;
    v_entity_id := NEW.follow_up_task_id;
    v_entity_type := 'follow_up';
    v_action := 'FOLLOWUP_CONTACT_LOGGED';
    v_summary_ar := 'توثيق تواصل متابعة عبر (' || NEW.channel || ')';
    v_summary_en := 'Recorded follow-up contact via ' || NEW.channel;

  ELSIF TG_TABLE_NAME = 'dose_events' AND TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    v_pharmacy_id := NEW.pharmacy_id;
    v_entity_id := NEW.id;
    v_entity_type := 'dose_event';
    v_action := 'DOSE_EVENT_UPDATED';
    v_summary_ar := 'تحديث حالة الجرعة إلى (' || NEW.status || ')';
    v_summary_en := 'Updated scheduled dose status to ' || NEW.status;

  ELSIF TG_TABLE_NAME = 'consultation_threads' AND TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    v_pharmacy_id := NEW.pharmacy_id;
    v_entity_id := NEW.id;
    v_entity_type := 'consultation';
    v_action := 'CONSULTATION_STATUS_UPDATED';
    v_summary_ar := 'تحديث حالة الاستشارة إلى (' || NEW.status || ')';
    v_summary_en := 'Updated consultation status to ' || NEW.status;

  ELSE
    RETURN NULL;
  END IF;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en
  )
  VALUES (
    v_pharmacy_id,
    v_uid,
    v_actor_name,
    v_actor_role,
    v_action,
    v_entity_type,
    v_entity_id,
    v_summary_ar,
    v_summary_en
  );

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_security.write_clinical_audit_log() FROM PUBLIC, anon, authenticated;
-- 13. public.issue_patient_apk_invitation(...) (from 0002; preserves pg_catalog, public, app_security, pg_temp)
CREATE OR REPLACE FUNCTION public.issue_patient_apk_invitation(
  p_patient_id uuid,
  p_invitation_purpose text DEFAULT 'initial_activation',
  p_recovery_reason text DEFAULT NULL,
  p_ttl_hours integer DEFAULT 72,
  p_recovery_identity_verified boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_security, pg_temp
AS $$
DECLARE
  v_pharmacy_id uuid;
  v_staff_name text;
  v_staff_role text;
  v_patient public.patients%ROWTYPE;
  v_raw_token text;
  v_token_hash text;
  v_handover_pin text;
  v_pin_hash text;
  v_inv_id uuid;
  v_recent_recovery_count integer;
BEGIN
  IF NOT app_security.is_active_pharmacist() THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'UNAUTHORIZED_NOT_PHARMACIST'
    );
  END IF;

  SELECT ps.pharmacy_id, ps.full_name, ps.role
    INTO v_pharmacy_id, v_staff_name, v_staff_role
  FROM public.pharmacy_staff ps
  WHERE ps.id = auth.uid() AND ps.is_active = true;

  SELECT * INTO v_patient
  FROM public.patients pt
  WHERE pt.id = p_patient_id
    AND pt.pharmacy_id = v_pharmacy_id
    AND pt.status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'PATIENT_NOT_FOUND_OR_CROSS_TENANT'
    );
  END IF;

  -- Audit H8 Fix: Prevent silent account replacement if patient is already linked to auth_user_id
  IF v_patient.auth_user_id IS NOT NULL AND p_invitation_purpose <> 'device_replacement_recovery' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'ALREADY_ACTIVATED_REQUIRES_RECOVERY_CEREMONY'
    );
  END IF;

  IF p_invitation_purpose = 'device_replacement_recovery' THEN
    IF v_patient.auth_user_id IS NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'PATIENT_NOT_ACTIVATED_USE_INITIAL_INVITATION'
      );
    END IF;

    -- V1.5.4 H4 Fix: Separation of privilege — recovery requires pharmacy_owner approval
    IF v_staff_role <> 'pharmacy_owner' THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_REQUIRES_PHARMACY_OWNER_APPROVAL'
      );
    END IF;

    -- Require independent verification attestation (in-person or verified phone challenge)
    IF p_recovery_identity_verified IS DISTINCT FROM true THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_IDENTITY_VERIFICATION_REQUIRED'
      );
    END IF;

    IF v_patient.verified_account_phone IS NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'NO_VERIFIED_PHONE_ON_FILE_FOR_RECOVERY'
      );
    END IF;

    IF p_recovery_reason IS NULL OR char_length(btrim(p_recovery_reason)) < 10 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_REASON_MIN_10_CHARS_REQUIRED'
      );
    END IF;

    -- Rate-limit recovery issuances per patient (max 2 within 24 hours)
    SELECT count(*) INTO v_recent_recovery_count
    FROM public.patient_apk_invitations pai
    WHERE pai.patient_id = p_patient_id
      AND pai.invitation_purpose = 'device_replacement_recovery'
      AND pai.issued_at > now() - interval '24 hours';

    IF v_recent_recovery_count >= 2 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_RATE_LIMIT_EXCEEDED'
      );
    END IF;
  END IF;

  -- Revoke any existing pending invitation for this patient before issuing a new one
  UPDATE public.patient_apk_invitations
     SET status = 'revoked',
         revoked_at = now()
   WHERE patient_id = p_patient_id
     AND pharmacy_id = v_pharmacy_id
     AND status = 'pending';

  -- Audit H3 & V1.5.4 H3 Fix: Schema-qualified CSPRNG 256-bit single-use token + 6-digit PIN
  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');
  v_handover_pin := app_security.generate_csprng_6digit_code();
  v_pin_hash := extensions.crypt(v_handover_pin, extensions.gen_salt('bf', 10));

  INSERT INTO public.patient_apk_invitations (
    pharmacy_id, patient_id, invitation_purpose, recovery_reason,
    approved_by_owner_id, recovery_identity_verified, superseded_auth_user_id,
    target_phone, token_hash, pharmacist_pin_hash, status, expires_at,
    issued_by_staff_id, issued_by_staff_name
  )
  VALUES (
    v_pharmacy_id, p_patient_id, p_invitation_purpose, p_recovery_reason,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery' THEN auth.uid() ELSE NULL END,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery' THEN true ELSE false END,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery' THEN v_patient.auth_user_id ELSE NULL END,
    COALESCE(v_patient.verified_account_phone, v_patient.phone),
    v_token_hash, v_pin_hash, 'pending',
    now() + make_interval(hours => LEAST(GREATEST(p_ttl_hours, 1), 168)),
    auth.uid(), v_staff_name
  )
  RETURNING id INTO v_inv_id;

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  )
  VALUES (
    v_pharmacy_id, auth.uid(), v_staff_name, v_staff_role,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery'
         THEN 'INVITATION_RECOVERY_ISSUED'
         ELSE 'INVITATION_ISSUED'
    END,
    'invitation', v_inv_id,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery'
         THEN 'إصدار دعوة استعادة جهاز بموافقة مالك الصيدلية والتحقق المستقل'
         ELSE 'إصدار دعوة تفعيل آمنة أحادية الاستخدام لتطبيق المريض'
    END,
    CASE WHEN p_invitation_purpose = 'device_replacement_recovery'
         THEN 'Issued owner-approved device replacement recovery invitation with verified identity check'
         ELSE 'Issued single-use patient APK invitation with CSPRNG handover PIN'
    END,
    jsonb_build_object(
      'purpose', p_invitation_purpose,
      'recoveryReason', p_recovery_reason,
      'approvedByOwnerId', CASE WHEN p_invitation_purpose = 'device_replacement_recovery' THEN auth.uid() ELSE NULL END,
      'supersededAuthUserId', v_patient.auth_user_id,
      'recoveryIdentityVerified', (p_invitation_purpose = 'device_replacement_recovery')
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'invitationId', v_inv_id,
    'invitationPurpose', p_invitation_purpose,
    'singleUseToken', v_raw_token,
    'pharmacistHandoverPin', v_handover_pin
  );
END;
$$;

REVOKE ALL ON FUNCTION public.issue_patient_apk_invitation(uuid, text, text, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_patient_apk_invitation(uuid, text, text, integer, boolean) TO authenticated, service_role;

-- 14. public.redeem_patient_apk_invitation(...) (from 0002; preserves pg_catalog, public, app_security, pg_temp)
CREATE OR REPLACE FUNCTION public.redeem_patient_apk_invitation(
  p_raw_token text,
  p_pharmacist_pin text,
  p_sms_otp text,
  p_bootstrap_auth_user_id uuid,
  p_device_label text,
  p_network_ip_hmac text,
  p_device_fingerprint_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_security, pg_temp
AS $$
DECLARE
  v_token_hash text;
  v_inv public.patient_apk_invitations%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_ip_failures integer;
  v_device_failures integer;
  v_new_failures integer;
  v_locked boolean := false;
  v_prior_auth_uid uuid;
BEGIN
  IF p_bootstrap_auth_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'MISSING_BOOTSTRAP_AUTH_USER'
    );
  END IF;

  SELECT count(*) INTO v_ip_failures
  FROM public.invitation_redemption_attempts
  WHERE network_ip_hmac = p_network_ip_hmac
    AND outcome = 'FAILED'
    AND attempted_at > now() - interval '15 minutes';

  SELECT count(*) INTO v_device_failures
  FROM public.invitation_redemption_attempts
  WHERE device_fingerprint_hash IS NOT NULL
    AND device_fingerprint_hash = p_device_fingerprint_hash
    AND outcome = 'FAILED'
    AND attempted_at > now() - interval '15 minutes';

  IF v_ip_failures >= 10 OR v_device_failures >= 5 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'RATE_LIMIT_EXCEEDED'
    );
  END IF;

  v_token_hash := encode(extensions.digest(coalesce(p_raw_token, ''), 'sha256'), 'hex');

  SELECT * INTO v_inv
  FROM public.patient_apk_invitations
  WHERE token_hash = v_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.invitation_redemption_attempts (
      network_ip_hmac, device_fingerprint_hash, phase, outcome, failure_reason
    ) VALUES (
      p_network_ip_hmac, p_device_fingerprint_hash, 'redemption', 'FAILED', 'TOKEN_NOT_FOUND'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVALID_INVITATION'
    );
  END IF;

  IF v_inv.status <> 'pending' THEN
    INSERT INTO public.invitation_redemption_attempts (
      invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
      phase, outcome, failure_reason
    ) VALUES (
      v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
      'redemption', 'FAILED', 'STATUS_' || upper(v_inv.status)
    );
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVITATION_NOT_PENDING',
      'status', v_inv.status
    );
  END IF;

  IF now() > v_inv.expires_at THEN
    UPDATE public.patient_apk_invitations SET status = 'expired' WHERE id = v_inv.id;
    INSERT INTO public.invitation_redemption_attempts (
      invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
      phase, outcome, failure_reason
    ) VALUES (
      v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
      'redemption', 'FAILED', 'EXPIRED'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'INVITATION_EXPIRED'
    );
  END IF;

  -- Verify BOTH Pharmacist Handover PIN AND non-expired SMS OTP
  IF v_inv.pharmacist_pin_hash <> extensions.crypt(coalesce(p_pharmacist_pin, ''), v_inv.pharmacist_pin_hash)
     OR v_inv.sms_otp_hash IS NULL
     OR v_inv.sms_otp_expires_at IS NULL
     OR now() > v_inv.sms_otp_expires_at
     OR v_inv.sms_otp_hash <> extensions.crypt(coalesce(p_sms_otp, ''), v_inv.sms_otp_hash)
  THEN
    v_new_failures := v_inv.failed_attempts + 1;
    v_locked := (v_new_failures >= v_inv.max_attempts);

    UPDATE public.patient_apk_invitations
       SET failed_attempts = v_new_failures,
           status = CASE WHEN v_locked THEN 'revoked' ELSE status END,
           revoked_at = CASE WHEN v_locked THEN now() ELSE revoked_at END
     WHERE id = v_inv.id;

    INSERT INTO public.invitation_redemption_attempts (
      invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
      phase, outcome, failure_reason
    ) VALUES (
      v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
      'redemption', 'FAILED', 'INVALID_PIN_OR_OTP'
    );

    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', CASE WHEN v_locked THEN 'RATE_LIMIT_LOCKOUT_REVOKED' ELSE 'IDENTITY_VERIFICATION_FAILED' END,
      'failedAttempts', v_new_failures,
      'lockedOut', v_locked
    );
  END IF;

  SELECT * INTO v_patient
  FROM public.patients
  WHERE id = v_inv.patient_id AND pharmacy_id = v_inv.pharmacy_id
  FOR UPDATE;

  IF NOT FOUND OR v_patient.status <> 'active' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'PATIENT_NOT_ACTIVE'
    );
  END IF;

  -- Audit H8 Fix: Block overwriting an existing linked auth_user_id unless invitation_purpose = 'device_replacement_recovery'
  IF v_patient.auth_user_id IS NOT NULL
     AND v_patient.auth_user_id <> p_bootstrap_auth_user_id
     AND v_inv.invitation_purpose <> 'device_replacement_recovery'
  THEN
    INSERT INTO public.invitation_redemption_attempts (
      invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
      phase, outcome, failure_reason
    ) VALUES (
      v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
      'redemption', 'FAILED', 'ACCOUNT_ALREADY_LINKED_NO_RECOVERY'
    );
    RETURN jsonb_build_object(
      'ok', false,
      'errorCode', 'ACCOUNT_ALREADY_LINKED_REQUIRES_RECOVERY'
    );
  END IF;

  -- V1.5.4 H4 Fix: Recovery ceremony requires owner approval, identity verification,
  -- matching prior auth_user_id snapshot, and a fresh auth_user_id for the new device.
  v_prior_auth_uid := v_patient.auth_user_id;
  IF v_inv.invitation_purpose = 'device_replacement_recovery' THEN
    IF v_inv.approved_by_owner_id IS NULL OR v_inv.recovery_identity_verified IS DISTINCT FROM true THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_APPROVAL_MISSING'
      );
    END IF;

    IF v_patient.auth_user_id IS DISTINCT FROM v_inv.superseded_auth_user_id THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_SUPERSEDED_USER_MISMATCH'
      );
    END IF;

    IF p_bootstrap_auth_user_id = v_inv.superseded_auth_user_id THEN
      RETURN jsonb_build_object(
        'ok', false,
        'errorCode', 'RECOVERY_REQUIRES_FRESH_AUTH_USER_ID'
      );
    END IF;
  END IF;

  -- Consume single-use invitation and atomically unlink prior auth_user_id before binding new one
  UPDATE public.patient_apk_invitations
     SET status = 'activated',
         activated_at = now(),
         activated_device_label = left(coalesce(p_device_label, 'Android APK'), 120),
         activated_auth_user_id = p_bootstrap_auth_user_id,
         sms_otp_hash = NULL
   WHERE id = v_inv.id;

  IF v_inv.invitation_purpose = 'device_replacement_recovery' THEN
    UPDATE public.patients
       SET auth_user_id = NULL,
           updated_at = now()
     WHERE id = v_inv.patient_id
       AND pharmacy_id = v_inv.pharmacy_id;
  END IF;

  UPDATE public.patients
     SET auth_user_id = p_bootstrap_auth_user_id,
         verified_account_phone = v_inv.target_phone,
         auth_linked_at = now(),
         updated_at = now()
   WHERE id = v_inv.patient_id
     AND pharmacy_id = v_inv.pharmacy_id;

  INSERT INTO public.invitation_redemption_attempts (
    invitation_id, pharmacy_id, patient_id, network_ip_hmac, device_fingerprint_hash,
    phase, outcome
  ) VALUES (
    v_inv.id, v_inv.pharmacy_id, v_inv.patient_id, p_network_ip_hmac, p_device_fingerprint_hash,
    'redemption', 'ACTIVATED'
  );

  INSERT INTO public.audit_logs (
    pharmacy_id, actor_user_id, actor_name, actor_role,
    action, entity_type, entity_id, summary_ar, summary_en, metadata
  ) VALUES (
    v_inv.pharmacy_id, p_bootstrap_auth_user_id, 'Patient APK User', 'patient_apk_user',
    CASE WHEN v_inv.invitation_purpose = 'device_replacement_recovery'
         THEN 'INVITATION_RECOVERY_REDEEMED'
         ELSE 'INVITATION_REDEEMED'
    END,
    'invitation', v_inv.id,
    CASE WHEN v_inv.invitation_purpose = 'device_replacement_recovery'
         THEN 'تمت استعادة حساب المريض وربط الجهاز الجديد مع إلغاء تفويض الجلسة السابقة'
         ELSE 'تفعيل حساب المريض بنجاح عبر رمز الدعوة والتحقق الثنائي (OTP + PIN)'
    END,
    CASE WHEN v_inv.invitation_purpose = 'device_replacement_recovery'
         THEN 'Patient device recovery completed with owner approval; prior auth user marked for session revocation'
         ELSE 'Patient APK invitation redeemed after SMS OTP and Pharmacist Handover PIN verification'
    END,
    jsonb_build_object(
      'purpose', v_inv.invitation_purpose,
      'deviceLabel', p_device_label,
      'supersededAuthUserId', v_prior_auth_uid,
      'newAuthUserId', p_bootstrap_auth_user_id,
      'requiresPriorSessionRevocation', (v_inv.invitation_purpose = 'device_replacement_recovery')
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'activated',
    'patientId', v_inv.patient_id,
    'pharmacyId', v_inv.pharmacy_id,
    'revokedPriorAuthUserId', CASE
      WHEN v_inv.invitation_purpose = 'device_replacement_recovery' THEN v_prior_auth_uid
      ELSE NULL
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text) TO service_role;

COMMIT;
