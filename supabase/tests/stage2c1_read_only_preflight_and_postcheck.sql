-- =============================================================================
-- MASAR Care — Stage 2C.1C Read-Only Preflight & Post-Test Verification Checklist
-- Target Database: PostgreSQL 17+ (Supabase Disposable Development Project)
--
-- STATUS: READ-ONLY SELECT CHECKLIST — DO NOT MODIFY DATABASE STATE
-- Run BOTH BEFORE and AFTER running `stage2c1_two_tenant_isolation_spec.sql`
-- (and diff the 4 result sets) using count-and-selected-field comparisons
-- across Auth + all 24 MASAR public tables and `DEV-TEST-001` (not full row
-- content checksums) to verify transaction rollback and zero leftover fixtures.
-- =============================================================================

-- 1. Comparable baseline counts & selected state fields across Auth + all 24 MASAR public tables
SELECT
  (SELECT count(*) FROM auth.users) AS auth_users_count,
  (SELECT count(*) FROM public.pharmacies) AS pharmacies_count,
  (SELECT count(*) FROM public.pharmacy_staff) AS pharmacy_staff_count,
  (SELECT count(*) FROM public.patients) AS patients_count,
  (SELECT count(*) FROM public.patient_conditions) AS patient_conditions_count,
  (SELECT count(*) FROM public.patient_allergies) AS patient_allergies_count,
  (SELECT count(*) FROM public.medication_catalog) AS medication_catalog_count,
  (SELECT count(*) FROM public.patient_medication_plans) AS medication_plans_count,
  (SELECT count(*) FROM public.regimen_versions) AS regimen_versions_count,
  (SELECT count(*) FROM public.medication_pause_periods) AS medication_pause_periods_count,
  (SELECT count(*) FROM public.scheduled_doses) AS scheduled_doses_count,
  (SELECT count(*) FROM public.dose_events) AS dose_events_count,
  (SELECT count(*) FROM public.unscheduled_dose_reports) AS unscheduled_dose_reports_count,
  (SELECT count(*) FROM public.dispensing_events) AS dispensing_events_count,
  (SELECT count(*) FROM public.refill_assessments) AS refill_assessments_count,
  (SELECT count(*) FROM public.lab_results) AS lab_results_count,
  (SELECT count(*) FROM public.follow_up_tasks) AS follow_up_tasks_count,
  (SELECT count(*) FROM public.follow_up_contact_logs) AS follow_up_contact_logs_count,
  (SELECT count(*) FROM public.consultation_threads) AS consultation_threads_count,
  (SELECT count(*) FROM public.consultation_messages) AS consultation_messages_count,
  (SELECT count(*) FROM public.patient_apk_invitations) AS patient_apk_invitations_count,
  (SELECT count(*) FROM public.invitation_redemption_attempts) AS invitation_redemption_attempts_count,
  (SELECT count(*) FROM public.audit_logs) AS audit_logs_count,
  (SELECT count(*) FROM public.bootstrap_state) AS bootstrap_state_count,
  (SELECT status FROM public.bootstrap_state WHERE singleton_key = true) AS bootstrap_status,
  (SELECT updated_at FROM public.bootstrap_state WHERE singleton_key = true) AS bootstrap_updated_at,
  (SELECT count(*) FROM public.staff_provisioning_requests) AS staff_provisioning_requests_count;

-- 2. Confirm ZERO leftover Stage 2C.1 (`2c10...` / `@masar-2c1.invalid` / `IQ-2C1-%` / `SYND-2C1-%` / `2C1-%`) fixture rows
SELECT
  (SELECT count(*) FROM auth.users WHERE email LIKE '%@masar-2c1.invalid' OR id::text LIKE '2c10%') AS leftover_auth_users,
  (SELECT count(*) FROM public.pharmacies WHERE id::text LIKE '2c10%' OR license_number IN ('IQ-2C1-A', 'IQ-2C1-B')) AS leftover_pharmacies,
  (SELECT count(*) FROM public.pharmacy_staff WHERE id::text LIKE '2c10%' OR pharmacy_id::text LIKE '2c10%' OR syndicate_license LIKE 'SYND-2C1-%') AS leftover_staff,
  (SELECT count(*) FROM public.patients WHERE id::text LIKE '2c10%' OR pharmacy_id::text LIKE '2c10%' OR patient_code LIKE '2C1-%') AS leftover_patients,
  (SELECT count(*) FROM public.patient_conditions WHERE pharmacy_id::text LIKE '2c10%' OR patient_id::text LIKE '2c10%') AS leftover_conditions,
  (SELECT count(*) FROM public.patient_allergies WHERE pharmacy_id::text LIKE '2c10%' OR patient_id::text LIKE '2c10%') AS leftover_allergies,
  (SELECT count(*) FROM public.patient_medication_plans WHERE id::text LIKE '2c10%' OR pharmacy_id::text LIKE '2c10%') AS leftover_plans,
  (SELECT count(*) FROM public.regimen_versions WHERE pharmacy_id::text LIKE '2c10%' OR medication_plan_id::text LIKE '2c10%') AS leftover_regimen_versions,
  (SELECT count(*) FROM public.medication_pause_periods WHERE pharmacy_id::text LIKE '2c10%' OR medication_plan_id::text LIKE '2c10%') AS leftover_pause_periods,
  (SELECT count(*) FROM public.scheduled_doses WHERE id::text LIKE '2c10%' OR pharmacy_id::text LIKE '2c10%') AS leftover_scheduled_doses,
  (SELECT count(*) FROM public.dose_events WHERE pharmacy_id::text LIKE '2c10%' OR patient_id::text LIKE '2c10%') AS leftover_dose_events,
  (SELECT count(*) FROM public.unscheduled_dose_reports WHERE pharmacy_id::text LIKE '2c10%' OR patient_id::text LIKE '2c10%') AS leftover_unscheduled_reports,
  (SELECT count(*) FROM public.dispensing_events WHERE id::text LIKE '2c10%' OR pharmacy_id::text LIKE '2c10%') AS leftover_dispensing,
  (SELECT count(*) FROM public.refill_assessments WHERE pharmacy_id::text LIKE '2c10%' OR patient_id::text LIKE '2c10%') AS leftover_refill_assessments,
  (SELECT count(*) FROM public.lab_results WHERE pharmacy_id::text LIKE '2c10%' OR patient_id::text LIKE '2c10%') AS leftover_lab_results,
  (SELECT count(*) FROM public.follow_up_tasks WHERE id::text LIKE '2c10%' OR pharmacy_id::text LIKE '2c10%') AS leftover_follow_up_tasks,
  (SELECT count(*) FROM public.follow_up_contact_logs WHERE pharmacy_id::text LIKE '2c10%' OR follow_up_task_id::text LIKE '2c10%') AS leftover_follow_up_contact_logs,
  (SELECT count(*) FROM public.consultation_threads WHERE id::text LIKE '2c10%' OR pharmacy_id::text LIKE '2c10%') AS leftover_consultation_threads,
  (SELECT count(*) FROM public.consultation_messages WHERE pharmacy_id::text LIKE '2c10%' OR thread_id::text LIKE '2c10%') AS leftover_consultation_messages,
  (SELECT count(*) FROM public.patient_apk_invitations WHERE id::text LIKE '2c10%' OR pharmacy_id::text LIKE '2c10%') AS leftover_invitations,
  (SELECT count(*) FROM public.invitation_redemption_attempts WHERE pharmacy_id::text LIKE '2c10%' OR invitation_id::text LIKE '2c10%') AS leftover_redemption_attempts,
  (SELECT count(*) FROM public.audit_logs WHERE pharmacy_id::text LIKE '2c10%' OR entity_id::text LIKE '2c10%') AS leftover_audit_logs,
  (SELECT count(*) FROM public.staff_provisioning_requests WHERE pharmacy_id::text LIKE '2c10%' OR owner_user_id::text LIKE '2c10%') AS leftover_staff_provisioning_requests;

-- 3. Count-and-selected-field comparison for existing fictional patient DEV-TEST-001, linked clinical tables, and pharmacy audit logs
SELECT
  p.id AS dev_patient_id,
  p.pharmacy_id AS dev_pharmacy_id,
  p.patient_code,
  p.full_name,
  p.status,
  p.clinical_notes,
  p.updated_at AS patient_updated_at,
  ph.phone AS pharmacy_phone,
  ph.updated_at AS pharmacy_updated_at,
  (SELECT count(*) FROM public.patient_conditions pc WHERE pc.patient_id = p.id) AS total_conditions,
  (SELECT count(*) FROM public.patient_conditions pc WHERE pc.patient_id = p.id AND pc.status = 'active') AS active_conditions,
  (SELECT count(*) FROM public.patient_allergies pa WHERE pa.patient_id = p.id) AS total_allergies,
  (SELECT count(*) FROM public.patient_allergies pa WHERE pa.patient_id = p.id AND pa.status = 'active') AS active_allergies,
  (SELECT count(*) FROM public.patient_medication_plans mp WHERE mp.patient_id = p.id) AS medication_plans,
  (SELECT max(mp.updated_at) FROM public.patient_medication_plans mp WHERE mp.patient_id = p.id) AS latest_plan_updated_at,
  (SELECT count(*) FROM public.regimen_versions rv JOIN public.patient_medication_plans mp ON mp.id = rv.medication_plan_id WHERE mp.patient_id = p.id) AS regimen_versions,
  (SELECT count(*) FROM public.medication_pause_periods pp JOIN public.patient_medication_plans mp ON mp.id = pp.medication_plan_id WHERE mp.patient_id = p.id) AS pause_periods,
  (SELECT count(*) FROM public.scheduled_doses sd WHERE sd.patient_id = p.id) AS scheduled_doses,
  (SELECT count(*) FROM public.dose_events de2 WHERE de2.patient_id = p.id) AS dose_events,
  (SELECT count(*) FROM public.unscheduled_dose_reports udr WHERE udr.patient_id = p.id) AS unscheduled_dose_reports,
  (SELECT count(*) FROM public.dispensing_events de WHERE de.patient_id = p.id) AS dispensing_events,
  (SELECT max(de.created_at) FROM public.dispensing_events de WHERE de.patient_id = p.id) AS latest_dispensing_at,
  (SELECT count(*) FROM public.refill_assessments ra WHERE ra.patient_id = p.id) AS refill_assessments,
  (SELECT count(*) FROM public.lab_results lr WHERE lr.patient_id = p.id) AS lab_results,
  (SELECT count(*) FROM public.follow_up_tasks ft WHERE ft.patient_id = p.id) AS follow_up_tasks,
  (SELECT max(ft.updated_at) FROM public.follow_up_tasks ft WHERE ft.patient_id = p.id) AS latest_followup_updated_at,
  (SELECT count(*) FROM public.follow_up_contact_logs fcl JOIN public.follow_up_tasks ft ON ft.id = fcl.follow_up_task_id WHERE ft.patient_id = p.id) AS follow_up_contact_logs,
  (SELECT count(*) FROM public.consultation_threads ct WHERE ct.patient_id = p.id) AS consultation_threads,
  (SELECT count(*) FROM public.consultation_messages cm JOIN public.consultation_threads ct ON ct.id = cm.thread_id WHERE ct.patient_id = p.id) AS consultation_messages,
  (SELECT count(*) FROM public.patient_apk_invitations pai WHERE pai.patient_id = p.id) AS patient_apk_invitations,
  (SELECT count(*) FROM public.audit_logs al WHERE al.pharmacy_id = p.pharmacy_id) AS pharmacy_audit_log_count,
  (SELECT max(al.timestamp) FROM public.audit_logs al WHERE al.pharmacy_id = p.pharmacy_id) AS latest_pharmacy_audit_at
FROM public.patients p
JOIN public.pharmacies ph ON ph.id = p.pharmacy_id
WHERE p.patient_code = 'DEV-TEST-001';

-- 4. Confirm clean default SQL role and empty JWT settings after rollback
SELECT
  current_user AS active_sql_role,
  COALESCE(pg_catalog.current_setting('request.jwt.claim.sub', true), '') AS jwt_sub,
  COALESCE(pg_catalog.current_setting('request.jwt.claims', true), '') AS jwt_claims;
