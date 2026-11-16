import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AuthenticatedPharmacistContext,
  SupabaseAuthLike,
  verifyActiveSessionMatchesUser,
} from '../services/authService';
import {
  ConnectedAuthStatus,
  ConnectedSessionController,
} from '../services/connectedSessionController';
import { CrmState, IAsyncCrmRepository } from '../services/crmRepository';
import {
  ConnectedAuthorizationError,
  createEmptyConnectedCrmState,
  isConnectedAuthorizationError,
  isSupabaseRlsPermissionError,
  SupabaseCrmRepository,
} from '../services/supabaseCrmRepository';

/**
 * ============================================================================
 * MASAR CARE — STAGE 2C.1 MULTI-TENANT SECURITY, RLS & AUTHORIZATION TESTS
 * ============================================================================
 * IMPORTANT SCOPE NOTICE:
 * These automated TypeScript tests run against an in-memory RLS/RPC simulator
 * and mocked Supabase auth sessions. They verify client, repository, session
 * controller, race-condition, and authorization-handling behavior locally.
 *
 * They do NOT prove live PostgreSQL RLS enforcement on Supabase. Live two-
 * tenant database verification remains queued behind explicit approval using
 * `supabase/tests/stage2c1_two_tenant_isolation_spec.sql`.
 * ============================================================================
 */

const PHARMACY_A_ID = 'aaaa1111-1111-4111-8111-111111111111';
const PHARMACY_B_ID = 'bbbb1111-1111-4111-8111-111111111111';
const PHARMACY_INACTIVE_ID = 'cccc1111-1111-4111-8111-111111111111';

const OWNER_A_ID = 'a0000001-1111-4111-8111-111111111111';
const STAFF_A_ID = 'a0000002-1111-4111-8111-111111111111';
const INACTIVE_STAFF_A_ID = 'a0000003-1111-4111-8111-111111111111';

const OWNER_B_ID = 'b0000001-1111-4111-8111-111111111111';
const STAFF_B_ID = 'b0000002-1111-4111-8111-111111111111';

const INACTIVE_PHARMACY_OWNER_ID = 'c0000001-1111-4111-8111-111111111111';
const UNLINKED_AUTH_USER_ID = 'd0000001-1111-4111-8111-111111111111';

const PATIENT_A1_ID = 'a1000001-1111-4111-8111-111111111111';
const PATIENT_B1_ID = 'b1000001-1111-4111-8111-111111111111';

const PLAN_A1_ID = 'a2000001-1111-4111-8111-111111111111';
const PLAN_B1_ID = 'b2000001-1111-4111-8111-111111111111';

const FOLLOWUP_A1_ID = 'a8000001-1111-4111-8111-111111111111';
const FOLLOWUP_B1_ID = 'b8000001-1111-4111-8111-111111111111';

const THREAD_A1_ID = 'a9000001-1111-4111-8111-111111111111';
const THREAD_B1_ID = 'b9000001-1111-4111-8111-111111111111';

const INVITATION_A1_ID = 'aa000001-1111-4111-8111-111111111111';
const INVITATION_B1_ID = 'ba000001-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;

interface SimUserCredential {
  id: string;
  email: string;
  password: string;
}

class TenantSimDb {
  public users = new Map<string, SimUserCredential>();
  public tables: Record<string, Row[]> = {
    pharmacies: [],
    pharmacy_staff: [],
    patients: [],
    patient_conditions: [],
    patient_allergies: [],
    patient_medication_plans: [],
    regimen_versions: [],
    medication_pause_periods: [],
    dispensing_events: [],
    refill_assessments: [],
    dose_events: [],
    lab_results: [],
    follow_up_tasks: [],
    follow_up_contact_logs: [],
    consultation_threads: [],
    consultation_messages: [],
    patient_apk_invitations: [],
    audit_logs: [],
  };
  private seq = 1;

  constructor() {
    this.seedFixtures();
  }

  public nextUuid(prefix = '99990000'): string {
    const tail = String(this.seq++).padStart(12, '0');
    return `${prefix}-1111-4111-8111-${tail}`;
  }

  private seedFixtures(): void {
    const creds: SimUserCredential[] = [
      { id: OWNER_A_ID, email: 'owner-a@masar.test', password: 'SecretPasswordA!' },
      { id: STAFF_A_ID, email: 'staff-a@masar.test', password: 'SecretPasswordA2!' },
      { id: INACTIVE_STAFF_A_ID, email: 'inactive-a@masar.test', password: 'SecretPasswordA3!' },
      { id: OWNER_B_ID, email: 'owner-b@masar.test', password: 'SecretPasswordB!' },
      { id: STAFF_B_ID, email: 'staff-b@masar.test', password: 'SecretPasswordB2!' },
      {
        id: INACTIVE_PHARMACY_OWNER_ID,
        email: 'inactive-pharm@masar.test',
        password: 'SecretPasswordC!',
      },
      { id: UNLINKED_AUTH_USER_ID, email: 'unlinked@masar.test', password: 'SecretPasswordD!' },
    ];
    for (const c of creds) {
      this.users.set(c.id, c);
    }

    this.tables.pharmacies.push(
      {
        id: PHARMACY_A_ID,
        name_ar: 'صيدلية مسار للاختبار الأمني أ',
        name_en: 'MASAR Security Test A',
        city: 'بغداد',
        governorate: 'بغداد',
        license_number: 'IQ-TEST-A-001',
        phone: '07701110001',
        timezone: 'Asia/Baghdad',
        is_active: true,
      },
      {
        id: PHARMACY_B_ID,
        name_ar: 'صيدلية مسار للاختبار الأمني ب',
        name_en: 'MASAR Security Test B',
        city: 'أربيل',
        governorate: 'أربيل',
        license_number: 'IQ-TEST-B-001',
        phone: '07702220001',
        timezone: 'Asia/Baghdad',
        is_active: true,
      },
      {
        id: PHARMACY_INACTIVE_ID,
        name_ar: 'صيدلية متوقفة للاختبار',
        name_en: 'MASAR Inactive Test Pharmacy',
        city: 'البصرة',
        governorate: 'البصرة',
        license_number: 'IQ-TEST-C-001',
        phone: '07703330001',
        timezone: 'Asia/Baghdad',
        is_active: false,
      }
    );

    this.tables.pharmacy_staff.push(
      {
        id: OWNER_A_ID,
        pharmacy_id: PHARMACY_A_ID,
        full_name: 'د. مالك الاختبار أ',
        role: 'pharmacy_owner',
        syndicate_license: 'SYND-A-1',
        phone: '07701110002',
        is_active: true,
        created_at: '2026-01-01T08:00:00Z',
      },
      {
        id: STAFF_A_ID,
        pharmacy_id: PHARMACY_A_ID,
        full_name: 'د. صيدلي مخول أ',
        role: 'authorized_pharmacist',
        syndicate_license: 'SYND-A-2',
        phone: '07701110003',
        is_active: true,
        created_at: '2026-01-02T08:00:00Z',
      },
      {
        id: INACTIVE_STAFF_A_ID,
        pharmacy_id: PHARMACY_A_ID,
        full_name: 'د. موظف موقوف أ',
        role: 'authorized_pharmacist',
        syndicate_license: 'SYND-A-3',
        phone: '07701110004',
        is_active: false,
        created_at: '2026-01-03T08:00:00Z',
      },
      {
        id: OWNER_B_ID,
        pharmacy_id: PHARMACY_B_ID,
        full_name: 'د. مالك الاختبار ب',
        role: 'pharmacy_owner',
        syndicate_license: 'SYND-B-1',
        phone: '07702220002',
        is_active: true,
        created_at: '2026-01-01T08:00:00Z',
      },
      {
        id: STAFF_B_ID,
        pharmacy_id: PHARMACY_B_ID,
        full_name: 'د. صيدلي مخول ب',
        role: 'authorized_pharmacist',
        syndicate_license: 'SYND-B-2',
        phone: '07702220003',
        is_active: true,
        created_at: '2026-01-02T08:00:00Z',
      },
      {
        id: INACTIVE_PHARMACY_OWNER_ID,
        pharmacy_id: PHARMACY_INACTIVE_ID,
        full_name: 'د. مالك صيدلية متوقفة',
        role: 'pharmacy_owner',
        syndicate_license: 'SYND-C-1',
        phone: '07703330002',
        is_active: true,
        created_at: '2026-01-01T08:00:00Z',
      }
    );

    this.tables.patients.push(
      {
        id: PATIENT_A1_ID,
        pharmacy_id: PHARMACY_A_ID,
        patient_code: 'SEC-A-001',
        full_name: 'مراجع اختبار أ١',
        phone: '07701119001',
        phone_owner_type: 'self',
        caregiver_name: null,
        date_of_birth: '1975-04-12',
        sex: 'male',
        contact_preference: 'whatsapp',
        clinical_notes: 'حالة أ السرية',
        registration_date: '2026-02-01',
        status: 'active',
        archived_at: null,
        archived_reason: null,
      },
      {
        id: PATIENT_B1_ID,
        pharmacy_id: PHARMACY_B_ID,
        patient_code: 'SEC-B-001',
        full_name: 'مراجع اختبار ب١',
        phone: '07702229001',
        phone_owner_type: 'self',
        caregiver_name: null,
        date_of_birth: '1980-09-21',
        sex: 'female',
        contact_preference: 'phone_call',
        clinical_notes: 'حالة ب السرية',
        registration_date: '2026-02-02',
        status: 'active',
        archived_at: null,
        archived_reason: null,
      }
    );

    this.tables.patient_conditions.push(
      {
        id: 'a1100001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_A_ID,
        patient_id: PATIENT_A1_ID,
        condition_name: 'Type 2 Diabetes',
        status: 'active',
        created_at: '2026-02-01T09:00:00Z',
      },
      {
        id: 'b1100001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_B_ID,
        patient_id: PATIENT_B1_ID,
        condition_name: 'Essential Hypertension',
        status: 'active',
        created_at: '2026-02-02T09:00:00Z',
      }
    );

    this.tables.patient_allergies.push(
      {
        id: 'a1200001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_A_ID,
        patient_id: PATIENT_A1_ID,
        substance: 'Penicillin A-Secret',
        severity: 'severe',
        reaction: 'Anaphylaxis',
        status: 'active',
        created_at: '2026-02-01T09:00:00Z',
      },
      {
        id: 'b1200001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_B_ID,
        patient_id: PATIENT_B1_ID,
        substance: 'Sulfamethoxazole B-Secret',
        severity: 'moderate',
        reaction: 'Rash',
        status: 'active',
        created_at: '2026-02-02T09:00:00Z',
      }
    );

    const scheduleDaily = {
      frequencyType: 'daily',
      timesPerDay: 2,
      doseSlots: [
        { id: 'slot-am', time24: '08:00', doseAmount: 1 },
        { id: 'slot-pm', time24: '20:00', doseAmount: 1 },
      ],
      timezone: 'Asia/Baghdad',
    };

    this.tables.patient_medication_plans.push(
      {
        id: PLAN_A1_ID,
        pharmacy_id: PHARMACY_A_ID,
        patient_id: PATIENT_A1_ID,
        catalog_id: null,
        brand_name: 'Glucophage A',
        generic_name: 'Metformin',
        strength: '500 mg',
        dosage_form: 'tablet',
        route: 'oral',
        dose_amount: 1,
        dose_unit: 'tablet',
        food_relation: 'with_food',
        verified_instructions: 'قرص صباحا ومساء مع الطعام',
        prescriber_name: 'د. طبيب أ',
        prescriber_specialty: 'الباطنية',
        start_date: '2026-02-01',
        end_date: null,
        is_ongoing: true,
        duration_days: null,
        status: 'active',
        status_changed_at: null,
        status_change_reason: null,
        current_version_number: 1,
        schedule: scheduleDaily,
        created_at: '2026-02-01T10:00:00Z',
        updated_at: '2026-02-01T10:00:00Z',
      },
      {
        id: PLAN_B1_ID,
        pharmacy_id: PHARMACY_B_ID,
        patient_id: PATIENT_B1_ID,
        catalog_id: null,
        brand_name: 'Norvasc B',
        generic_name: 'Amlodipine',
        strength: '5 mg',
        dosage_form: 'tablet',
        route: 'oral',
        dose_amount: 1,
        dose_unit: 'tablet',
        food_relation: 'any_time',
        verified_instructions: 'قرص واحد يوميا مساء',
        prescriber_name: 'د. طبيب ب',
        prescriber_specialty: 'القلبية',
        start_date: '2026-02-02',
        end_date: null,
        is_ongoing: true,
        duration_days: null,
        status: 'active',
        status_changed_at: null,
        status_change_reason: null,
        current_version_number: 1,
        schedule: {
          frequencyType: 'daily',
          timesPerDay: 1,
          doseSlots: [{ id: 'slot-pm', time24: '20:00', doseAmount: 1 }],
          timezone: 'Asia/Baghdad',
        },
        created_at: '2026-02-02T10:00:00Z',
        updated_at: '2026-02-02T10:00:00Z',
      }
    );

    this.tables.regimen_versions.push(
      {
        id: 'a3000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_A_ID,
        medication_plan_id: PLAN_A1_ID,
        version_number: 1,
        effective_from: '2026-02-01',
        effective_to: null,
        dose_amount: 1,
        dose_unit: 'tablet',
        food_relation: 'with_food',
        verified_instructions: 'قرص صباحا ومساء مع الطعام',
        schedule: scheduleDaily,
        changed_by_staff_name: 'د. مالك الاختبار أ',
        change_reason: 'Initial plan A',
        created_at: '2026-02-01T10:00:00Z',
      },
      {
        id: 'b3000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_B_ID,
        medication_plan_id: PLAN_B1_ID,
        version_number: 1,
        effective_from: '2026-02-02',
        effective_to: null,
        dose_amount: 1,
        dose_unit: 'tablet',
        food_relation: 'any_time',
        verified_instructions: 'قرص واحد يوميا مساء',
        schedule: this.tables.patient_medication_plans[1].schedule,
        changed_by_staff_name: 'د. مالك الاختبار ب',
        change_reason: 'Initial plan B',
        created_at: '2026-02-02T10:00:00Z',
      }
    );

    this.tables.medication_pause_periods.push(
      {
        id: 'a4000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_A_ID,
        medication_plan_id: PLAN_A1_ID,
        paused_from: '2026-02-10',
        resumed_at: '2026-02-12',
        reason: 'Fasting procedure A',
        created_at: '2026-02-10T08:00:00Z',
      },
      {
        id: 'b4000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_B_ID,
        medication_plan_id: PLAN_B1_ID,
        paused_from: '2026-02-11',
        resumed_at: '2026-02-13',
        reason: 'Monitoring hold B',
        created_at: '2026-02-11T08:00:00Z',
      }
    );

    this.tables.dispensing_events.push(
      {
        id: 'a5000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_A_ID,
        patient_id: PATIENT_A1_ID,
        medication_plan_id: PLAN_A1_ID,
        regimen_version_number: 1,
        dispensed_quantity: 60,
        quantity_unit: 'tablet',
        package_count: 2,
        package_size: 30,
        batch_number: 'BATCH-A1',
        expiry_date: '2027-06-01',
        dispensing_date: '2026-02-01',
        dispensed_by_staff_id: OWNER_A_ID,
        dispensed_by_staff_name: 'د. مالك الاختبار أ',
        notes: 'صرف أ',
        estimated_daily_consumption: 2,
        estimated_supply_days: 30,
        estimated_supply_end_date: '2026-03-03',
        forecast_assumptions: '30 days supply',
        is_partial_fill: false,
        calculation_source: 'provisional_client_unverified',
        verification_status: 'unverified',
        algorithm_version: 'masar_refill_v1',
        created_at: '2026-02-01T11:00:00Z',
      },
      {
        id: 'b5000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_B_ID,
        patient_id: PATIENT_B1_ID,
        medication_plan_id: PLAN_B1_ID,
        regimen_version_number: 1,
        dispensed_quantity: 30,
        quantity_unit: 'tablet',
        package_count: 1,
        package_size: 30,
        batch_number: 'BATCH-B1',
        expiry_date: '2027-08-01',
        dispensing_date: '2026-02-02',
        dispensed_by_staff_id: OWNER_B_ID,
        dispensed_by_staff_name: 'د. مالك الاختبار ب',
        notes: 'صرف ب',
        estimated_daily_consumption: 1,
        estimated_supply_days: 30,
        estimated_supply_end_date: '2026-03-04',
        forecast_assumptions: '30 days supply',
        is_partial_fill: false,
        calculation_source: 'provisional_client_unverified',
        verification_status: 'unverified',
        algorithm_version: 'masar_refill_v1',
        created_at: '2026-02-02T11:00:00Z',
      }
    );

    this.tables.refill_assessments.push(
      {
        id: 'a5100001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_A_ID,
        patient_id: PATIENT_A1_ID,
        medication_plan_id: PLAN_A1_ID,
        refill_status: 'adequate',
        estimated_days_remaining: 14,
      },
      {
        id: 'b5100001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_B_ID,
        patient_id: PATIENT_B1_ID,
        medication_plan_id: PLAN_B1_ID,
        refill_status: 'due_soon',
        estimated_days_remaining: 4,
      }
    );

    this.tables.dose_events.push(
      {
        id: 'a6000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_A_ID,
        patient_id: PATIENT_A1_ID,
        medication_plan_id: PLAN_A1_ID,
        regimen_version_number: 1,
        scheduled_date: '2026-02-02',
        scheduled_time24: '08:00',
        planned_dose_amount: 1,
        dose_unit: 'tablet',
        status: 'taken',
        confirmed_at: '2026-02-02T08:05:00Z',
        patient_note: 'A dose',
      },
      {
        id: 'b6000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_B_ID,
        patient_id: PATIENT_B1_ID,
        medication_plan_id: PLAN_B1_ID,
        regimen_version_number: 1,
        scheduled_date: '2026-02-03',
        scheduled_time24: '20:00',
        planned_dose_amount: 1,
        dose_unit: 'tablet',
        status: 'taken',
        confirmed_at: '2026-02-03T20:10:00Z',
        patient_note: 'B dose',
      }
    );

    this.tables.lab_results.push(
      {
        id: 'a7000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_A_ID,
        patient_id: PATIENT_A1_ID,
        test_name: 'HbA1c Test-A',
        value: '7.4',
        unit: '%',
        reference_range: '< 7.0',
        is_abnormal: true,
        test_date: '2026-02-01',
        notes: 'Lab A',
        recorded_by_staff_id: OWNER_A_ID,
        recorded_by_staff_name: 'د. مالك الاختبار أ',
      },
      {
        id: 'b7000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_B_ID,
        patient_id: PATIENT_B1_ID,
        test_name: 'Creatinine Test-B',
        value: '1.1',
        unit: 'mg/dL',
        reference_range: '0.7 - 1.3',
        is_abnormal: false,
        test_date: '2026-02-02',
        notes: 'Lab B',
        recorded_by_staff_id: OWNER_B_ID,
        recorded_by_staff_name: 'د. مالك الاختبار ب',
      }
    );

    this.tables.follow_up_tasks.push(
      {
        id: FOLLOWUP_A1_ID,
        pharmacy_id: PHARMACY_A_ID,
        patient_id: PATIENT_A1_ID,
        related_medication_plan_id: PLAN_A1_ID,
        type: 'refill_due',
        due_date: '2026-02-25',
        status: 'pending',
        notes: 'FollowUp A',
        assigned_staff_id: OWNER_A_ID,
        assigned_staff_name: 'د. مالك الاختبار أ',
        created_at: '2026-02-01T12:00:00Z',
      },
      {
        id: FOLLOWUP_B1_ID,
        pharmacy_id: PHARMACY_B_ID,
        patient_id: PATIENT_B1_ID,
        related_medication_plan_id: PLAN_B1_ID,
        type: 'adherence_check',
        due_date: '2026-02-26',
        status: 'pending',
        notes: 'FollowUp B',
        assigned_staff_id: OWNER_B_ID,
        assigned_staff_name: 'د. مالك الاختبار ب',
        created_at: '2026-02-02T12:00:00Z',
      }
    );

    this.tables.follow_up_contact_logs.push(
      {
        id: 'a8100001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_A_ID,
        follow_up_task_id: FOLLOWUP_A1_ID,
        contacted_at: '2026-02-15T10:00:00Z',
        channel: 'whatsapp',
        outcome: 'reached',
        summary: 'Contact Log A',
        staff_id: OWNER_A_ID,
        staff_name: 'د. مالك الاختبار أ',
      },
      {
        id: 'b8100001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_B_ID,
        follow_up_task_id: FOLLOWUP_B1_ID,
        contacted_at: '2026-02-16T10:00:00Z',
        channel: 'phone_call',
        outcome: 'reached',
        summary: 'Contact Log B',
        staff_id: OWNER_B_ID,
        staff_name: 'د. مالك الاختبار ب',
      }
    );

    this.tables.consultation_threads.push(
      {
        id: THREAD_A1_ID,
        pharmacy_id: PHARMACY_A_ID,
        patient_id: PATIENT_A1_ID,
        subject: 'استفسار دوائي أ',
        status: 'open',
        updated_at: '2026-02-15T11:00:00Z',
      },
      {
        id: THREAD_B1_ID,
        pharmacy_id: PHARMACY_B_ID,
        patient_id: PATIENT_B1_ID,
        subject: 'استفسار دوائي ب',
        status: 'open',
        updated_at: '2026-02-16T11:00:00Z',
      }
    );

    this.tables.consultation_messages.push(
      {
        id: 'a9100001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_A_ID,
        thread_id: THREAD_A1_ID,
        sender_type: 'patient',
        sender_staff_id: null,
        sender_name: 'مراجع اختبار أ١',
        body: 'رسالة المراجع أ السرية',
        approved_by_pharmacist: false,
        sent_at: '2026-02-15T11:00:00Z',
      },
      {
        id: 'b9100001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_B_ID,
        thread_id: THREAD_B1_ID,
        sender_type: 'patient',
        sender_staff_id: null,
        sender_name: 'مراجع اختبار ب١',
        body: 'رسالة المراجع ب السرية',
        approved_by_pharmacist: false,
        sent_at: '2026-02-16T11:00:00Z',
      }
    );

    this.tables.patient_apk_invitations.push(
      {
        id: INVITATION_A1_ID,
        pharmacy_id: PHARMACY_A_ID,
        patient_id: PATIENT_A1_ID,
        invitation_purpose: 'initial_activation',
        recovery_reason: null,
        approved_by_owner_id: null,
        recovery_identity_verified: false,
        target_phone: '07701119001',
        status: 'pending',
        issued_at: '2026-02-10T08:00:00Z',
        expires_at: '2026-02-17T08:00:00Z',
        activated_at: null,
        revoked_at: null,
        issued_by_staff_id: OWNER_A_ID,
        issued_by_staff_name: 'د. مالك الاختبار أ',
        failed_attempts: 0,
        max_attempts: 5,
        otp_send_count: 0,
        activated_device_label: null,
      },
      {
        id: INVITATION_B1_ID,
        pharmacy_id: PHARMACY_B_ID,
        patient_id: PATIENT_B1_ID,
        invitation_purpose: 'initial_activation',
        recovery_reason: null,
        approved_by_owner_id: null,
        recovery_identity_verified: false,
        target_phone: '07702229001',
        status: 'pending',
        issued_at: '2026-02-11T08:00:00Z',
        expires_at: '2026-02-18T08:00:00Z',
        activated_at: null,
        revoked_at: null,
        issued_by_staff_id: OWNER_B_ID,
        issued_by_staff_name: 'د. مالك الاختبار ب',
        failed_attempts: 0,
        max_attempts: 5,
        otp_send_count: 0,
        activated_device_label: null,
      }
    );

    this.tables.audit_logs.push(
      {
        id: 'ab000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_A_ID,
        timestamp: '2026-02-01T10:00:00Z',
        actor_name: 'د. مالك الاختبار أ',
        actor_role: 'pharmacy_owner',
        action: 'PATIENT_CREATED',
        entity_type: 'patient',
        entity_id: PATIENT_A1_ID,
        summary_ar: 'سجل تدقيق أ',
        summary_en: 'Audit log A',
      },
      {
        id: 'bb000001-1111-4111-8111-111111111111',
        pharmacy_id: PHARMACY_B_ID,
        timestamp: '2026-02-02T10:00:00Z',
        actor_name: 'د. مالك الاختبار ب',
        actor_role: 'pharmacy_owner',
        action: 'PATIENT_CREATED',
        entity_type: 'patient',
        entity_id: PATIENT_B1_ID,
        summary_ar: 'سجل تدقيق ب',
        summary_en: 'Audit log B',
      }
    );
  }

  public resolveActiveStaff(userId: string | null): {
    staff: Row;
    pharmacy: Row;
  } | null {
    if (!userId) return null;
    const staff = this.tables.pharmacy_staff.find((s) => s.id === userId && s.is_active === true);
    if (!staff) return null;
    const pharmacy = this.tables.pharmacies.find(
      (p) => p.id === staff.pharmacy_id && p.is_active === true
    );
    if (!pharmacy) return null;
    return { staff, pharmacy };
  }
}

class TenantEnforcingClientSimulator {
  private currentUserId: string | null = null;
  private authListeners = new Set<(event: string, session: unknown) => void>();
  public signOutCalls = 0;

  constructor(private readonly db: TenantSimDb, initialUserId: string | null = null) {
    this.currentUserId = initialUserId;
  }

  public setUserId(userId: string | null): void {
    this.currentUserId = userId;
  }

  public getUserId(): string | null {
    return this.currentUserId;
  }

  public emitAuthEvent(event: string, userId: string | null): void {
    const user = userId ? this.db.users.get(userId) ?? { id: userId, email: 'user@masar.test' } : null;
    const session = user
      ? { access_token: `tok-${user.id}`, user: { id: user.id, email: user.email } }
      : null;
    for (const cb of this.authListeners) {
      cb(event, session);
    }
  }

  public asSupabaseClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }

  public asAuthLike(): SupabaseAuthLike {
    return this as unknown as SupabaseAuthLike;
  }

  public auth = {
    getUser: async () => {
      if (!this.currentUserId) {
        return { data: { user: null }, error: { message: 'Auth session missing!' } };
      }
      const cred = this.db.users.get(this.currentUserId);
      return {
        data: {
          user: {
            id: this.currentUserId,
            email: cred?.email ?? `${this.currentUserId}@masar.test`,
          },
        },
        error: null,
      };
    },
    getSession: async () => {
      if (!this.currentUserId) {
        return { data: { session: null }, error: null };
      }
      const cred = this.db.users.get(this.currentUserId);
      return {
        data: {
          session: {
            access_token: `tok-${this.currentUserId}`,
            user: {
              id: this.currentUserId,
              email: cred?.email ?? `${this.currentUserId}@masar.test`,
            },
          },
        },
        error: null,
      };
    },
    signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
      const normalized = email.trim().toLowerCase();
      const matched = Array.from(this.db.users.values()).find(
        (u) => u.email.toLowerCase() === normalized && u.password === password
      );
      if (!matched) {
        return {
          data: { user: null, session: null },
          error: { message: 'Invalid login credentials' },
        };
      }
      if (this.currentUserId && this.currentUserId !== matched.id) {
        this.emitAuthEvent('SIGNED_OUT', null);
      }
      this.currentUserId = matched.id;
      this.emitAuthEvent('SIGNED_IN', matched.id);
      return {
        data: {
          user: { id: matched.id, email: matched.email },
          session: {
            access_token: `tok-${matched.id}`,
            user: { id: matched.id, email: matched.email },
          },
        },
        error: null,
      };
    },
    signOut: async () => {
      this.signOutCalls += 1;
      this.currentUserId = null;
      this.emitAuthEvent('SIGNED_OUT', null);
      return { error: null };
    },
    onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
      this.authListeners.add(cb);
      return {
        data: {
          subscription: {
            unsubscribe: () => {
              this.authListeners.delete(cb);
            },
          },
        },
      };
    },
  };

  private canSelectRow(table: string, row: Row): boolean {
    if (!this.currentUserId) return false;
    const ctx = this.db.resolveActiveStaff(this.currentUserId);
    if (!ctx) return false;
    const actorPharmacyId = String(ctx.pharmacy.id);
    if (table === 'pharmacies') {
      return String(row.id) === actorPharmacyId;
    }
    return String(row.pharmacy_id) === actorPharmacyId;
  }

  public from(table: string) {
    const db = this.db;
    const self = this;

    const applyFilters = (rows: Row[], filters: Array<{ col: string; val: unknown }>): Row[] =>
      rows.filter((r) => filters.every((f) => r[f.col] === f.val));

    return {
      select(_columns?: string) {
        const filters: Array<{ col: string; val: unknown }> = [];
        const chain = {
          eq(col: string, val: unknown) {
            filters.push({ col, val });
            return chain;
          },
          order(_col: string, _opts?: { ascending?: boolean }) {
            return chain;
          },
          range(from: number, to: number) {
            if (!self.currentUserId) {
              return Promise.resolve({
                data: null,
                error: { code: '42501', message: 'permission denied for table ' + table },
              });
            }
            const visible = applyFilters(
              (db.tables[table] ?? []).filter((r) => self.canSelectRow(table, r)),
              filters
            );
            return Promise.resolve({
              data: visible.slice(from, to + 1),
              error: null,
            });
          },
          maybeSingle() {
            if (!self.currentUserId) {
              return Promise.resolve({
                data: null,
                error: { code: '42501', message: 'permission denied for table ' + table },
              });
            }
            const visible = applyFilters(
              (db.tables[table] ?? []).filter((r) => self.canSelectRow(table, r)),
              filters
            );
            return Promise.resolve({ data: visible[0] ?? null, error: null });
          },
        };
        return chain;
      },

      insert(payload: Row) {
        if (!self.currentUserId) {
          return Promise.resolve({
            data: null,
            error: { code: '42501', message: `permission denied for table ${table} (anon)` },
          });
        }
        const ctx = db.resolveActiveStaff(self.currentUserId);
        if (!ctx) {
          return Promise.resolve({
            data: null,
            error: {
              code: '42501',
              message: `new row violates row-level security policy for table "${table}"`,
            },
          });
        }
        const actorPharmacyId = String(ctx.pharmacy.id);
        const directRevokedTables = new Set([
          'patients',
          'patient_conditions',
          'patient_allergies',
          'patient_medication_plans',
          'regimen_versions',
          'medication_pause_periods',
          'dispensing_events',
          'refill_assessments',
          'audit_logs',
          'pharmacy_staff',
          'pharmacies',
        ]);
        if (directRevokedTables.has(table)) {
          return Promise.resolve({
            data: null,
            error: {
              code: '42501',
              message: `permission denied for table ${table} (direct write revoked)`,
            },
          });
        }
        if (payload.pharmacy_id !== actorPharmacyId) {
          return Promise.resolve({
            data: null,
            error: {
              code: '42501',
              message: `new row violates row-level security policy for table "${table}"`,
            },
          });
        }
        // Composite FK check simulation: parent patient / follow_up must belong to same pharmacy
        if (payload.patient_id) {
          const patient = db.tables.patients.find(
            (p) => p.id === payload.patient_id && p.pharmacy_id === actorPharmacyId
          );
          if (!patient) {
            return Promise.resolve({
              data: null,
              error: {
                code: '23503',
                message: `insert violates composite foreign key constraint on ${table} (cross-tenant patient)`,
              },
            });
          }
        }
        if (payload.follow_up_task_id) {
          const task = db.tables.follow_up_tasks.find(
            (t) => t.id === payload.follow_up_task_id && t.pharmacy_id === actorPharmacyId
          );
          if (!task) {
            return Promise.resolve({
              data: null,
              error: {
                code: '23503',
                message: `insert violates composite foreign key constraint on ${table} (cross-tenant follow-up)`,
              },
            });
          }
        }
        const row = { id: db.nextUuid('99000001'), ...payload };
        db.tables[table] = db.tables[table] ?? [];
        db.tables[table].push(row);
        return Promise.resolve({ data: [row], error: null });
      },

      update(patch: Row) {
        const filters: Array<{ col: string; val: unknown }> = [];
        const executeUpdate = () => {
          if (!self.currentUserId) {
            return Promise.resolve({
              data: null,
              error: { code: '42501', message: `permission denied for table ${table}` },
            });
          }
          if (table === 'audit_logs') {
            return Promise.resolve({
              data: null,
              error: { code: '42501', message: 'audit_logs is append-only immutable' },
            });
          }
          const ctx = db.resolveActiveStaff(self.currentUserId);
          if (!ctx) {
            return Promise.resolve({
              data: null,
              error: {
                code: '42501',
                message: `row-level security policy violation for table "${table}"`,
              },
            });
          }
          if (
            (table === 'pharmacies' || table === 'pharmacy_staff') &&
            ctx.staff.role !== 'pharmacy_owner'
          ) {
            return Promise.resolve({
              data: null,
              error: {
                code: '42501',
                message: `Only pharmacy_owner may update ${table}`,
              },
            });
          }

          const actorPharmacyId = String(ctx.pharmacy.id);
          const visibleMatches = applyFilters(
            (db.tables[table] ?? []).filter((r) => self.canSelectRow(table, r)),
            filters
          );

          if (
            (patch.pharmacy_id !== undefined && patch.pharmacy_id !== actorPharmacyId) ||
            (table === 'pharmacies' && patch.id !== undefined && patch.id !== actorPharmacyId)
          ) {
            return Promise.resolve({
              data: null,
              error: {
                code: '42501',
                message: `new row violates row-level security policy for table "${table}"`,
              },
            });
          }

          for (const row of visibleMatches) {
            Object.assign(row, patch);
          }
          return Promise.resolve({ data: visibleMatches, error: null });
        };

        const chain: {
          eq: (col: string, val: unknown) => typeof chain;
          then: Promise<{ data: Row[] | null; error: unknown }>['then'];
        } = {
          eq(col: string, val: unknown) {
            filters.push({ col, val });
            return chain;
          },
          then(onfulfilled, onrejected) {
            return executeUpdate().then(onfulfilled, onrejected);
          },
        };
        return chain;
      },
    };
  }

  public async rpc(name: string, params: Record<string, unknown> = {}) {
    if (!this.currentUserId) {
      return {
        data: null,
        error: { code: '42501', message: `permission denied for function ${name}` },
      };
    }
    const ctx = this.db.resolveActiveStaff(this.currentUserId);
    if (!ctx) {
      return {
        data: null,
        error: { code: '42501', message: 'Active pharmacist session required' },
      };
    }
    const actorPharmacyId = String(ctx.pharmacy.id);

    if (name === 'create_patient_with_clinical_tags') {
      const patientId = this.db.nextUuid('77000001');
      this.db.tables.patients.push({
        id: patientId,
        pharmacy_id: actorPharmacyId,
        patient_code: params.p_patient_code,
        full_name: params.p_full_name,
        phone: params.p_phone,
        phone_owner_type: params.p_phone_owner_type ?? 'self',
        caregiver_name: params.p_caregiver_name ?? null,
        date_of_birth: params.p_date_of_birth,
        sex: params.p_sex,
        contact_preference: params.p_contact_preference,
        clinical_notes: params.p_clinical_notes ?? '',
        registration_date: params.p_registration_date,
        status: 'active',
        archived_at: null,
        archived_reason: null,
      });
      const conditions = Array.isArray(params.p_chronic_conditions)
        ? params.p_chronic_conditions
        : [];
      for (const cond of conditions) {
        this.db.tables.patient_conditions.push({
          id: this.db.nextUuid('77100001'),
          pharmacy_id: actorPharmacyId,
          patient_id: patientId,
          condition_name: String(cond),
          status: 'active',
          created_at: new Date().toISOString(),
        });
      }
      const allergies = Array.isArray(params.p_allergies) ? params.p_allergies : [];
      for (const a of allergies as Array<Record<string, unknown>>) {
        this.db.tables.patient_allergies.push({
          id: this.db.nextUuid('77200001'),
          pharmacy_id: actorPharmacyId,
          patient_id: patientId,
          substance: String(a.substance),
          severity: String(a.severity ?? 'moderate'),
          reaction: a.reaction ?? null,
          status: 'active',
          created_at: new Date().toISOString(),
        });
      }
      return { data: { ok: true, patientId }, error: null };
    }

    if (name === 'update_patient_with_clinical_tags') {
      const patient = this.db.tables.patients.find(
        (p) => p.id === params.p_patient_id && p.pharmacy_id === actorPharmacyId
      );
      if (!patient) {
        return {
          data: null,
          error: {
            code: '42501',
            message: `Patient ${params.p_patient_id} not found or belongs to another pharmacy.`,
          },
        };
      }
      Object.assign(patient, (params.p_patch as Row) ?? {});
      return { data: { ok: true, patientId: patient.id }, error: null };
    }

    if (name === 'get_clinical_safety_capabilities') {
      return {
        data: {
          ok: true,
          stage: 'stage2c2b_v2',
          supportsV2MedicationPlans: true,
          supportsV2DispensingIdempotency: true,
          enforcesServerCriticalAllergyOverride: true,
          serverRefillAuthorityReady: true,
        },
        error: null,
      };
    }

    if (
      name === 'create_medication_plan_with_version' ||
      name === 'create_medication_plan_with_version_v2'
    ) {
      const patient = this.db.tables.patients.find(
        (p) => p.id === params.p_patient_id && p.pharmacy_id === actorPharmacyId
      );
      if (!patient) {
        return {
          data: null,
          error: {
            code: '42501',
            message: `Patient ${params.p_patient_id} not found or belongs to another pharmacy.`,
          },
        };
      }
      const planId = this.db.nextUuid('88000001');
      this.db.tables.patient_medication_plans.push({
        id: planId,
        pharmacy_id: actorPharmacyId,
        patient_id: patient.id,
        catalog_id: params.p_catalog_id ?? null,
        brand_name: params.p_brand_name,
        generic_name: params.p_generic_name,
        strength: params.p_strength,
        dosage_form: params.p_dosage_form,
        route: params.p_route,
        dose_amount: params.p_dose_amount,
        dose_unit: params.p_dose_unit,
        food_relation: params.p_food_relation,
        verified_instructions: params.p_verified_instructions,
        prescriber_name: params.p_prescriber_name ?? null,
        prescriber_specialty: params.p_prescriber_specialty ?? null,
        start_date: params.p_start_date,
        end_date: params.p_end_date ?? null,
        is_ongoing: Boolean(params.p_is_ongoing),
        duration_days: params.p_duration_days ?? null,
        status: 'active',
        current_version_number: 1,
        schedule: params.p_schedule,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return { data: { ok: true, planId }, error: null };
    }

    if (
      name === 'update_medication_plan_version' ||
      name === 'update_medication_plan_version_v2' ||
      name === 'change_medication_plan_status'
    ) {
      const plan = this.db.tables.patient_medication_plans.find(
        (m) => m.id === params.p_plan_id && m.pharmacy_id === actorPharmacyId
      );
      if (!plan) {
        return {
          data: null,
          error: {
            code: '42501',
            message: `Medication plan ${params.p_plan_id} not found or belongs to another pharmacy.`,
          },
        };
      }
      if (name === 'change_medication_plan_status') {
        plan.status = params.p_status;
      } else {
        plan.current_version_number = Number(plan.current_version_number) + 1;
      }
      return { data: { ok: true, planId: plan.id }, error: null };
    }

    if (
      name === 'record_dispensing_with_refill' ||
      name === 'record_dispensing_with_refill_v2'
    ) {
      const patient = this.db.tables.patients.find(
        (p) => p.id === params.p_patient_id && p.pharmacy_id === actorPharmacyId
      );
      const plan = this.db.tables.patient_medication_plans.find(
        (m) =>
          m.id === params.p_medication_plan_id &&
          m.patient_id === params.p_patient_id &&
          m.pharmacy_id === actorPharmacyId
      );
      if (!patient || !plan) {
        return {
          data: null,
          error: {
            code: '42501',
            message: 'Patient or medication plan not found or belongs to another pharmacy.',
          },
        };
      }
      const dispensingEventId = this.db.nextUuid('88500001');
      this.db.tables.dispensing_events.push({
        id: dispensingEventId,
        pharmacy_id: actorPharmacyId,
        patient_id: patient.id,
        medication_plan_id: plan.id,
        regimen_version_number: plan.current_version_number,
        dispensed_quantity: params.p_dispensed_quantity,
        quantity_unit: params.p_quantity_unit,
        dispensing_date: params.p_dispensing_date,
        dispensed_by_staff_id: ctx.staff.id,
        dispensed_by_staff_name: ctx.staff.full_name,
        forecast_assumptions: params.p_forecast_assumptions ?? '',
        is_partial_fill: Boolean(params.p_is_partial_fill),
        created_at: new Date().toISOString(),
      });
      return { data: { ok: true, dispensingEventId }, error: null };
    }

    if (name === 'send_consultation_reply') {
      const thread = this.db.tables.consultation_threads.find(
        (t) => t.id === params.p_thread_id && t.pharmacy_id === actorPharmacyId
      );
      if (!thread) {
        return {
          data: null,
          error: {
            code: '42501',
            message: `Consultation thread ${params.p_thread_id} not found or belongs to another pharmacy.`,
          },
        };
      }
      const messageId = this.db.nextUuid('88900001');
      this.db.tables.consultation_messages.push({
        id: messageId,
        pharmacy_id: actorPharmacyId,
        thread_id: thread.id,
        sender_type: 'pharmacist',
        sender_staff_id: ctx.staff.id,
        sender_name: ctx.staff.full_name,
        body: params.p_body,
        approved_by_pharmacist: true,
        sent_at: new Date().toISOString(),
      });
      return { data: { ok: true, threadId: thread.id, messageId }, error: null };
    }

    if (name === 'revoke_patient_apk_invitation') {
      const patient = this.db.tables.patients.find(
        (p) => p.id === params.p_patient_id && p.pharmacy_id === actorPharmacyId
      );
      if (!patient) {
        return {
          data: null,
          error: {
            code: '42501',
            message: `Patient ${params.p_patient_id} not found or belongs to another pharmacy.`,
          },
        };
      }
      const inv = this.db.tables.patient_apk_invitations.find(
        (i) => i.patient_id === patient.id && i.pharmacy_id === actorPharmacyId && i.status === 'pending'
      );
      if (!inv) {
        return { data: { ok: false, errorCode: 'INVITATION_NOT_PENDING' }, error: null };
      }
      inv.status = 'revoked';
      inv.revoked_at = new Date().toISOString();
      return { data: { ok: true, invitationId: inv.id, patientId: patient.id }, error: null };
    }

    return { data: null, error: { code: '42883', message: `Unknown RPC ${name}` } };
  }
}

function makeAuthContext(
  db: TenantSimDb,
  userId: string
): AuthenticatedPharmacistContext {
  const cred = db.users.get(userId)!;
  const resolved = db.resolveActiveStaff(userId)!;
  return {
    userId,
    email: cred.email,
    pharmacyId: String(resolved.pharmacy.id),
    role: resolved.staff.role as AuthenticatedPharmacistContext['role'],
    staff: {
      id: String(resolved.staff.id),
      pharmacyId: String(resolved.pharmacy.id),
      fullName: String(resolved.staff.full_name),
      role: resolved.staff.role as AuthenticatedPharmacistContext['role'],
      syndicateLicense: resolved.staff.syndicate_license
        ? String(resolved.staff.syndicate_license)
        : undefined,
      phone: String(resolved.staff.phone),
      isActive: Boolean(resolved.staff.is_active),
    },
    pharmacy: {
      id: String(resolved.pharmacy.id),
      nameAr: String(resolved.pharmacy.name_ar),
      nameEn: String(resolved.pharmacy.name_en),
      city: String(resolved.pharmacy.city),
      governorate: String(resolved.pharmacy.governorate),
      licenseNumber: String(resolved.pharmacy.license_number),
      phone: String(resolved.pharmacy.phone),
      timezone: 'Asia/Baghdad',
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeControllerHarness(options: {
  client: SupabaseAuthLike | SupabaseClient;
  createRepository: (
    client: SupabaseAuthLike | SupabaseClient,
    ctx: AuthenticatedPharmacistContext
  ) => IAsyncCrmRepository;
}) {
  let repo: IAsyncCrmRepository | null = null;
  let pharmacist: AuthenticatedPharmacistContext | null = null;
  let state: CrmState = createEmptyConnectedCrmState();
  let authStatus: ConnectedAuthStatus = 'checking';
  let authError: string | null = null;
  let hasUnauthorizedSession = false;
  let selectedPatientId: string | null = 'initial-selected-patient';
  let resetNavCount = 0;

  const controller = new ConnectedSessionController({
    client: options.client,
    createRepository: options.createRepository,
    callbacks: {
      getLang: () => 'en',
      getRepo: () => repo,
      setRepo: (next) => {
        repo = next;
      },
      setAuthenticatedPharmacist: (ctx) => {
        pharmacist = ctx;
      },
      setState: (next) => {
        state = next;
      },
      setAuthStatus: (next) => {
        authStatus = next;
      },
      setAuthError: (err) => {
        authError = err;
      },
      setHasUnauthorizedSession: (flag) => {
        hasUnauthorizedSession = flag;
      },
      setIsLoading: () => {},
      setAsyncError: () => {},
      resetNavigation: () => {
        resetNavCount += 1;
        selectedPatientId = null;
      },
    },
  });

  return {
    controller,
    snapshot: () => ({
      repo,
      pharmacist,
      state,
      authStatus,
      authError,
      hasUnauthorizedSession,
      selectedPatientId,
      setSelectedPatientId: (id: string | null) => {
        selectedPatientId = id;
      },
      resetNavCount,
    }),
  };
}

async function runTests() {
  console.log('=== MASAR Care Stage 2C.1 Multi-Tenant Security, RLS & Authorization Suite ===');
  console.log(
    '[SCOPE] Running against in-memory RLS/RPC simulator (does NOT prove live PostgreSQL RLS).'
  );

  // ==========================================================================
  // PART 1: TWO-PHARMACY CROSS-TENANT ISOLATION (A -> B and B -> A)
  // ==========================================================================
  const db = new TenantSimDb();
  const simA = new TenantEnforcingClientSimulator(db, OWNER_A_ID);
  const simB = new TenantEnforcingClientSimulator(db, OWNER_B_ID);
  const simStaffA = new TenantEnforcingClientSimulator(db, STAFF_A_ID);
  const simStaffB = new TenantEnforcingClientSimulator(db, STAFF_B_ID);
  const simAnon = new TenantEnforcingClientSimulator(db, null);

  const repoA = new SupabaseCrmRepository(simA.asSupabaseClient(), makeAuthContext(db, OWNER_A_ID));
  const repoB = new SupabaseCrmRepository(simB.asSupabaseClient(), makeAuthContext(db, OWNER_B_ID));

  // 1-6. Read isolation across all clinical & operational datasets (A vs B)
  {
    const stateA = await repoA.getStateAsync();
    const stateB = await repoB.getStateAsync();

    assert.equal(stateA.pharmacy.id, PHARMACY_A_ID);
    assert.equal(stateB.pharmacy.id, PHARMACY_B_ID);

    // 1. Patients
    assert.deepEqual(
      stateA.patients.map((p) => p.id),
      [PATIENT_A1_ID]
    );
    assert.deepEqual(
      stateB.patients.map((p) => p.id),
      [PATIENT_B1_ID]
    );

    // 2. Clinical conditions, allergies, labs
    assert.deepEqual(stateA.patients[0].chronicConditions, ['Type 2 Diabetes']);
    assert.deepEqual(stateB.patients[0].chronicConditions, ['Essential Hypertension']);
    assert.deepEqual(
      stateA.patients[0].allergies.map((a) => a.substance),
      ['Penicillin A-Secret']
    );
    assert.deepEqual(
      stateB.patients[0].allergies.map((a) => a.substance),
      ['Sulfamethoxazole B-Secret']
    );
    assert.deepEqual(
      stateA.labResults.map((l) => l.testName),
      ['HbA1c Test-A']
    );
    assert.deepEqual(
      stateB.labResults.map((l) => l.testName),
      ['Creatinine Test-B']
    );

    // 3. Medication plans, regimen versions, pause periods
    assert.deepEqual(
      stateA.medicationPlans.map((m) => m.id),
      [PLAN_A1_ID]
    );
    assert.deepEqual(
      stateB.medicationPlans.map((m) => m.id),
      [PLAN_B1_ID]
    );
    assert.equal(stateA.medicationPlans[0].regimenHistory.length, 1);
    assert.equal(stateA.medicationPlans[0].pausePeriods?.[0]?.reason, 'Fasting procedure A');
    assert.equal(stateB.medicationPlans[0].pausePeriods?.[0]?.reason, 'Monitoring hold B');

    // 4. Dispensing & refill history
    assert.deepEqual(
      stateA.dispensingEvents.map((d) => d.batchNumber),
      ['BATCH-A1']
    );
    assert.deepEqual(
      stateB.dispensingEvents.map((d) => d.batchNumber),
      ['BATCH-B1']
    );

    // 5. Follow-up tasks & contact logs
    assert.deepEqual(
      stateA.followUps.map((f) => f.id),
      [FOLLOWUP_A1_ID]
    );
    assert.equal(stateA.followUps[0].contactHistory[0].summary, 'Contact Log A');
    assert.deepEqual(
      stateB.followUps.map((f) => f.id),
      [FOLLOWUP_B1_ID]
    );
    assert.equal(stateB.followUps[0].contactHistory[0].summary, 'Contact Log B');

    // 6. Audit logs & direct cross-tenant SELECT probes
    assert.deepEqual(
      stateA.auditLogs.map((a) => a.summaryEn),
      ['Audit log A']
    );
    assert.deepEqual(
      stateB.auditLogs.map((a) => a.summaryEn),
      ['Audit log B']
    );

    // Direct query bypassing client pharmacy_id filter (explicitly asking for Pharmacy B patient while logged in as A)
    const crossReadAtoB = await simA
      .from('patients')
      .select('*')
      .eq('id', PATIENT_B1_ID)
      .range(0, 10);
    assert.equal((crossReadAtoB.data ?? []).length, 0, 'A must read 0 rows from B patients');

    const crossReadBtoA = await simB
      .from('patient_allergies')
      .select('*')
      .eq('patient_id', PATIENT_A1_ID)
      .range(0, 10);
    assert.equal((crossReadBtoA.data ?? []).length, 0, 'B must read 0 rows from A allergies');

    const crossAuditAtoB = await simA
      .from('audit_logs')
      .select('*')
      .eq('pharmacy_id', PHARMACY_B_ID)
      .range(0, 10);
    assert.equal((crossAuditAtoB.data ?? []).length, 0, 'A must read 0 rows from B audit_logs');

    console.log('✓ 1-6. Read isolation verified across patients, clinical, meds, dispensing, follow-ups, and audit logs (A<->B)');
  }

  // 7 & 8. Staff & Pharmacy Config Update Isolation (Role + Tenant checks)
  {
    // Same-pharmacy owner can update staff & pharmacy config
    const ownerUpdateStaffA = await simA
      .from('pharmacy_staff')
      .update({ phone: '07701119999' })
      .eq('id', STAFF_A_ID);
    assert.equal(ownerUpdateStaffA.error, null);
    assert.equal((ownerUpdateStaffA.data ?? []).length, 1);

    const ownerUpdatePharmA = await simA
      .from('pharmacies')
      .update({ phone: '07701118888' })
      .eq('id', PHARMACY_A_ID);
    assert.equal(ownerUpdatePharmA.error, null);
    assert.equal((ownerUpdatePharmA.data ?? []).length, 1);

    // Cross-pharmacy owner attempts (A -> B and B -> A) affect 0 rows
    const crossStaffUpdateAtoB = await simA
      .from('pharmacy_staff')
      .update({ is_active: false })
      .eq('id', STAFF_B_ID);
    assert.equal((crossStaffUpdateAtoB.data ?? []).length, 0);
    assert.equal(
      db.tables.pharmacy_staff.find((s) => s.id === STAFF_B_ID)?.is_active,
      true,
      'Staff B must remain active after cross-tenant update attempt by Owner A'
    );

    const crossPharmUpdateBtoA = await simB
      .from('pharmacies')
      .update({ name_en: 'HIJACKED' })
      .eq('id', PHARMACY_A_ID);
    assert.equal((crossPharmUpdateBtoA.data ?? []).length, 0);
    assert.equal(
      db.tables.pharmacies.find((p) => p.id === PHARMACY_A_ID)?.name_en,
      'MASAR Security Test A'
    );

    // Same-pharmacy authorized_pharmacist cannot update pharmacy_staff or pharmacies
    const staffUpdateOwnPharm = await simStaffA
      .from('pharmacies')
      .update({ name_en: 'Unauthorized Edit' })
      .eq('id', PHARMACY_A_ID);
    assert.equal(isSupabaseRlsPermissionError(staffUpdateOwnPharm.error), true);

    const staffUpdateOtherStaff = await simStaffB
      .from('pharmacy_staff')
      .update({ role: 'pharmacy_owner' })
      .eq('id', STAFF_B_ID);
    assert.equal(isSupabaseRlsPermissionError(staffUpdateOtherStaff.error), true);

    console.log('✓ 7-8. Staff & pharmacy owner update isolation verified (cross-tenant & non-owner blocked)');
  }

  // 9. Manipulated pharmacy_id INSERT & composite-FK cross-tenant parent injection blocked
  {
    // Owner A tries inserting a lab_result with pharmacy_id = PHARMACY_B_ID
    const insertManipulatedLabAtoB = await simA.from('lab_results').insert({
      pharmacy_id: PHARMACY_B_ID,
      patient_id: PATIENT_B1_ID,
      test_name: 'Injected Lab',
      value: '99',
      unit: 'mg/dL',
      reference_range: '1-10',
      is_abnormal: true,
      test_date: '2026-02-20',
      recorded_by_staff_id: OWNER_A_ID,
      recorded_by_staff_name: 'Attacker',
    });
    assert.equal(isSupabaseRlsPermissionError(insertManipulatedLabAtoB.error), true);

    // Owner B tries inserting a follow_up_task with pharmacy_id = PHARMACY_A_ID
    const insertManipulatedFollowUpBtoA = await simB.from('follow_up_tasks').insert({
      pharmacy_id: PHARMACY_A_ID,
      patient_id: PATIENT_A1_ID,
      type: 'refill_due',
      due_date: '2026-03-01',
      status: 'pending',
      notes: 'Injected task',
      assigned_staff_id: OWNER_B_ID,
      assigned_staff_name: 'Attacker B',
    });
    assert.equal(isSupabaseRlsPermissionError(insertManipulatedFollowUpBtoA.error), true);

    // Owner A passes own pharmacy_id = A, but cross-tenant patient_id = B1 (composite FK defense)
    const compositeFkBypassAttempt = await simA.from('lab_results').insert({
      pharmacy_id: PHARMACY_A_ID,
      patient_id: PATIENT_B1_ID,
      test_name: 'FK Probe',
      value: '1.0',
      unit: '%',
      reference_range: '<6',
      is_abnormal: false,
      test_date: '2026-02-20',
      recorded_by_staff_id: OWNER_A_ID,
      recorded_by_staff_name: 'Owner A',
    });
    assert.equal(compositeFkBypassAttempt.error?.code, '23503');

    // Direct write bypasses to patients / patient_allergies remain revoked
    const directPatientInsert = await simA.from('patients').insert({
      pharmacy_id: PHARMACY_A_ID,
      patient_code: 'BYPASS-1',
      full_name: 'Bypass',
    });
    assert.equal(isSupabaseRlsPermissionError(directPatientInsert.error), true);

    console.log('✓ 9. Manipulated pharmacy_id & composite-FK cross-tenant inserts rejected');
  }

  // 10. Cross-tenant RPC calls rejected (A -> B and B -> A) + positive same-pharmacy RPCs succeed
  {
    const baseMedInput = {
      patientId: PATIENT_B1_ID,
      brandName: 'CrossMed',
      genericName: 'Metformin',
      strength: '500mg',
      dosageForm: 'tablet' as const,
      route: 'oral' as const,
      doseAmount: 1,
      doseUnit: 'tablet',
      foodRelation: 'with_food' as const,
      verifiedInstructions: 'Once daily',
      startDate: '2026-02-20',
      isOngoing: true,
      schedule: {
        frequencyType: 'daily' as const,
        timesPerDay: 1,
        doseSlots: [{ id: 'slot-1', time24: '08:00', doseAmount: 1 }],
        timezone: 'Asia/Baghdad' as const,
      },
    };

    // A attacking B via all pharmacist RPCs
    await assert.rejects(
      () => repoA.updatePatientAsync(PATIENT_B1_ID, { clinicalNotes: 'Hijacked' }),
      (err) => isSupabaseRlsPermissionError(err)
    );
    await assert.rejects(
      () => repoA.addMedicationPlanAsync({ ...baseMedInput, patientId: PATIENT_B1_ID }),
      (err) => isSupabaseRlsPermissionError(err)
    );
    await assert.rejects(
      () => repoA.updateMedicationPlanAsync(PLAN_B1_ID, baseMedInput, 'Cross-tenant edit'),
      (err) => isSupabaseRlsPermissionError(err)
    );
    await assert.rejects(
      () => repoA.changeMedicationStatusAsync(PLAN_B1_ID, 'paused', 'Cross-tenant pause'),
      (err) => isSupabaseRlsPermissionError(err)
    );
    await assert.rejects(
      () => repoA.sendConsultationReplyAsync(THREAD_B1_ID, 'Unauthorized reply'),
      (err) => isSupabaseRlsPermissionError(err)
    );
    await assert.rejects(
      () => repoA.revokeInvitationAsync(PATIENT_B1_ID, 'Cross-tenant revoke'),
      (err) => isSupabaseRlsPermissionError(err)
    );
    const crossDispenseAtoB = await simA.rpc('record_dispensing_with_refill', {
      p_patient_id: PATIENT_B1_ID,
      p_medication_plan_id: PLAN_B1_ID,
      p_dispensed_quantity: 10,
      p_quantity_unit: 'tablet',
      p_dispensing_date: '2026-02-20',
      p_is_partial_fill: false,
    });
    assert.equal(isSupabaseRlsPermissionError(crossDispenseAtoB.error), true);

    // Stage 2C.2B _v2 capability & cross-tenant RPC isolation probes
    const anonCapsProbe = await simAnon.rpc('get_clinical_safety_capabilities', {});
    assert.equal(isSupabaseRlsPermissionError(anonCapsProbe.error), true);
    const ownerACapsProbe = await simA.rpc('get_clinical_safety_capabilities', {});
    assert.equal(ownerACapsProbe.error, null);
    assert.equal((ownerACapsProbe.data as { stage?: string })?.stage, 'stage2c2b_v2');

    const crossPlanCreateV2AtoB = await simA.rpc('create_medication_plan_with_version_v2', {
      p_patient_id: PATIENT_B1_ID,
      p_brand_name: 'CrossMed',
    });
    assert.equal(isSupabaseRlsPermissionError(crossPlanCreateV2AtoB.error), true);
    const crossPlanUpdateV2AtoB = await simA.rpc('update_medication_plan_version_v2', {
      p_plan_id: PLAN_B1_ID,
      p_expected_version_number: 1,
    });
    assert.equal(isSupabaseRlsPermissionError(crossPlanUpdateV2AtoB.error), true);
    const crossDispenseV2AtoB = await simA.rpc('record_dispensing_with_refill_v2', {
      p_patient_id: PATIENT_B1_ID,
      p_medication_plan_id: PLAN_B1_ID,
      p_dispensed_quantity: 10,
      p_quantity_unit: 'tablet',
      p_dispensing_date: '2026-02-20',
      p_is_partial_fill: false,
      p_expected_regimen_version_number: 1,
      p_client_event_uuid: '2c10a999-0000-4000-8000-000000000001',
    });
    assert.equal(isSupabaseRlsPermissionError(crossDispenseV2AtoB.error), true);

    // B attacking A via RPCs (symmetric direction)
    await assert.rejects(
      () => repoB.updatePatientAsync(PATIENT_A1_ID, { clinicalNotes: 'Hijacked by B' }),
      (err) => isSupabaseRlsPermissionError(err)
    );
    await assert.rejects(
      () => repoB.sendConsultationReplyAsync(THREAD_A1_ID, 'Unauthorized B reply'),
      (err) => isSupabaseRlsPermissionError(err)
    );
    await assert.rejects(
      () => repoB.revokeInvitationAsync(PATIENT_A1_ID, 'Cross-tenant B revoke'),
      (err) => isSupabaseRlsPermissionError(err)
    );
    const crossDispenseV2BtoA = await simB.rpc('record_dispensing_with_refill_v2', {
      p_patient_id: PATIENT_A1_ID,
      p_medication_plan_id: PLAN_A1_ID,
      p_dispensed_quantity: 10,
      p_quantity_unit: 'tablet',
      p_dispensing_date: '2026-02-20',
      p_is_partial_fill: false,
      p_expected_regimen_version_number: 1,
      p_client_event_uuid: '2c10b999-0000-4000-8000-000000000001',
    });
    assert.equal(isSupabaseRlsPermissionError(crossDispenseV2BtoA.error), true);

    // Confirm Pharmacy B invitation remained pending and A patient notes remained intact
    assert.equal(
      db.tables.patient_apk_invitations.find((i) => i.id === INVITATION_B1_ID)?.status,
      'pending'
    );
    assert.equal(
      db.tables.patients.find((p) => p.id === PATIENT_A1_ID)?.clinical_notes,
      'حالة أ السرية'
    );

    // Positive control: Legitimate same-pharmacy operations succeed
    const addedA = await repoA.addPatientAsync({
      patientCode: 'SEC-A-002',
      fullName: 'مراجع جديد أ٢',
      phone: '07701119002',
      phoneOwnerType: 'self',
      dateOfBirth: '1988-05-05',
      sex: 'male',
      chronicConditions: ['Asthma'],
      allergies: [{ id: 'tmp-1', substance: 'Aspirin', severity: 'moderate' }],
      contactPreference: 'whatsapp',
      clinicalNotes: 'Legitimate patient in A',
      registrationDate: '2026-02-20',
    });
    assert.equal(addedA.patient.pharmacyId, PHARMACY_A_ID);
    assert.equal(addedA.patient.allergies[0].substance, 'Aspirin');

    // Cross-tenant follow_up_tasks RLS filtering via repository: A->B leaves B pending, A->A updates 1 row
    await repoA.updateFollowUpStatusAsync(FOLLOWUP_B1_ID, 'completed');
    assert.equal(
      db.tables.follow_up_tasks.find((t) => t.id === FOLLOWUP_B1_ID)?.status,
      'pending',
      'Cross-tenant follow_up_tasks update A->B must affect 0 rows and leave B task pending'
    );
    await repoA.updateFollowUpStatusAsync(FOLLOWUP_A1_ID, 'completed');
    assert.equal(
      db.tables.follow_up_tasks.find((t) => t.id === FOLLOWUP_A1_ID)?.status,
      'completed',
      'Same-pharmacy follow_up_tasks update A->A must succeed'
    );

    const replyB = await repoB.sendConsultationReplyAsync(THREAD_B1_ID, 'رد الصيدلي ب الموثق');
    const threadB = replyB.consultations.find((c) => c.id === THREAD_B1_ID)!;
    assert.equal(threadB.messages.length, 2);
    assert.equal(threadB.messages[1].approvedByPharmacist, true);

    console.log('✓ 10. Cross-tenant RPC attacks blocked (A<->B) & legitimate same-pharmacy workflows succeeded');
  }

  // ==========================================================================
  // PART 2: SESSION, ROLE, ACCOUNT-SWITCH & RACE-CONDITION TESTS
  // ==========================================================================

  // S1 & S2. Pharmacy owner login + authorized pharmacist login
  {
    const sim = new TenantEnforcingClientSimulator(db, null);
    const h = makeControllerHarness({
      client: sim.asSupabaseClient(),
      createRepository: (c, ctx) => new SupabaseCrmRepository(c as SupabaseClient, ctx),
    });

    await h.controller.signIn('owner-a@masar.test', 'SecretPasswordA!');
    assert.equal(h.snapshot().authStatus, 'authenticated');
    assert.equal(h.snapshot().pharmacist?.role, 'pharmacy_owner');
    assert.equal(h.snapshot().state.pharmacy.id, PHARMACY_A_ID);

    await h.controller.signIn('staff-b@masar.test', 'SecretPasswordB2!');
    assert.equal(h.snapshot().authStatus, 'authenticated');
    assert.equal(h.snapshot().pharmacist?.role, 'authorized_pharmacist');
    assert.equal(h.snapshot().state.pharmacy.id, PHARMACY_B_ID);
    assert.deepEqual(
      h.snapshot().state.patients.map((p) => p.id),
      [PATIENT_B1_ID]
    );
    h.controller.dispose();
    console.log('✓ S1-S2. Owner login and authorized_pharmacist login verified');
  }

  // S3. Anonymous access denied
  {
    const anonWrite = await simAnon.from('lab_results').insert({
      pharmacy_id: PHARMACY_A_ID,
      patient_id: PATIENT_A1_ID,
      test_name: 'Anon',
    });
    assert.equal(isSupabaseRlsPermissionError(anonWrite.error), true);

    const h = makeControllerHarness({
      client: simAnon.asAuthLike(),
      createRepository: (c, ctx) => new SupabaseCrmRepository(c as SupabaseClient, ctx),
    });
    await h.controller.restoreInitialSession();
    assert.equal(h.snapshot().authStatus, 'unauthenticated');
    assert.equal(h.snapshot().state.pharmacy.id, '');
    assert.equal(h.snapshot().state.patients.length, 0);
    h.controller.dispose();
    console.log('✓ S3. Anonymous session & direct anonymous write denied');
  }

  // S4. Authenticated user without pharmacy_staff membership rejected
  {
    const simUnlinked = new TenantEnforcingClientSimulator(db, null);
    const h = makeControllerHarness({
      client: simUnlinked.asSupabaseClient(),
      createRepository: (c, ctx) => new SupabaseCrmRepository(c as SupabaseClient, ctx),
    });
    await assert.rejects(
      () => h.controller.signIn('unlinked@masar.test', 'SecretPasswordD!'),
      /not linked to an authorized pharmacy_staff record/i
    );
    assert.equal(h.snapshot().authStatus, 'unauthorized');
    assert.equal(h.snapshot().hasUnauthorizedSession, false);
    assert.equal(h.snapshot().state.patients.length, 0);
    assert.equal(simUnlinked.getUserId(), null, 'Unauthorized session must be signed out');
    h.controller.dispose();
    console.log('✓ S4. Authenticated user without pharmacy_staff membership rejected & signed out');
  }

  // S5 & S6. Inactive staff & inactive pharmacy rejected (both via RLS empty result and explicit status flags)
  {
    const simInactiveStaff = new TenantEnforcingClientSimulator(db, null);
    const h1 = makeControllerHarness({
      client: simInactiveStaff.asSupabaseClient(),
      createRepository: (c, ctx) => new SupabaseCrmRepository(c as SupabaseClient, ctx),
    });
    await assert.rejects(
      () => h1.controller.signIn('inactive-a@masar.test', 'SecretPasswordA3!'),
      /not linked to an authorized pharmacy_staff record|deactivated/i
    );
    assert.equal(h1.snapshot().authStatus, 'unauthorized');
    assert.equal(h1.snapshot().state.patients.length, 0);
    assert.equal(simInactiveStaff.getUserId(), null);
    h1.controller.dispose();

    const simInactivePharm = new TenantEnforcingClientSimulator(db, null);
    const h2 = makeControllerHarness({
      client: simInactivePharm.asSupabaseClient(),
      createRepository: (c, ctx) => new SupabaseCrmRepository(c as SupabaseClient, ctx),
    });
    await assert.rejects(
      () => h2.controller.signIn('inactive-pharm@masar.test', 'SecretPasswordC!'),
      /not linked to an authorized pharmacy_staff record|currently inactive/i
    );
    assert.equal(h2.snapshot().authStatus, 'unauthorized');
    assert.equal(h2.snapshot().state.pharmacy.id, '');
    assert.equal(simInactivePharm.getUserId(), null);
    h2.controller.dispose();
    console.log('✓ S5-S6. Inactive staff and inactive pharmacy rejected & signed out');
  }

  // S7. Invalid credentials & expired post-hydration session handling
  {
    const sim = new TenantEnforcingClientSimulator(db, null);
    const h = makeControllerHarness({
      client: sim.asSupabaseClient(),
      createRepository: (c, ctx) => new SupabaseCrmRepository(c as SupabaseClient, ctx),
    });
    await assert.rejects(
      () => h.controller.signIn('owner-a@masar.test', 'WrongPassword!'),
      /Invalid email or password/i
    );
    assert.equal(
      h.snapshot().authStatus,
      'unauthenticated',
      'Bad password must remain unauthenticated (login form) rather than unauthorized lockout screen'
    );
    assert.ok(h.snapshot().authError);

    // Sign in properly, then expire underlying Supabase session and refresh controller state
    await h.controller.signIn('owner-a@masar.test', 'SecretPasswordA!');
    assert.equal(h.snapshot().authStatus, 'authenticated');
    sim.setUserId(null); // expired/missing session on server
    const verified = await verifyActiveSessionMatchesUser(sim.asAuthLike(), OWNER_A_ID);
    assert.equal(verified.status, 'missing');
    await h.controller.refreshState();
    assert.equal(h.snapshot().authStatus, 'unauthenticated');
    assert.equal(h.snapshot().state.patients.length, 0);
    assert.equal(h.snapshot().selectedPatientId, null);
    h.controller.dispose();
    console.log('✓ S7. Invalid credentials and expired post-hydration session handled safely');
  }

  // S8. Session revoked during data loading (hydration failure clears workspace immediately)
  {
    const sim = new TenantEnforcingClientSimulator(db, OWNER_A_ID);
    const h = makeControllerHarness({
      client: sim.asSupabaseClient(),
      createRepository: () => ({
        mode: 'supabase_stage2',
        async getStateAsync() {
          throw new ConnectedAuthorizationError(
            'STAFF_INACTIVE',
            'Staff deactivated mid-load'
          );
        },
        resetAsync: async () => createEmptyConnectedCrmState(),
        setActiveStaffAsync: async () => createEmptyConnectedCrmState(),
        addPatientAsync: async () => {
          throw new Error('unused');
        },
        updatePatientAsync: async () => createEmptyConnectedCrmState(),
        archivePatientAsync: async () => createEmptyConnectedCrmState(),
        restorePatientAsync: async () => createEmptyConnectedCrmState(),
        addMedicationPlanAsync: async () => {
          throw new Error('unused');
        },
        updateMedicationPlanAsync: async () => createEmptyConnectedCrmState(),
        changeMedicationStatusAsync: async () => createEmptyConnectedCrmState(),
        recordDispensingAsync: async () => {
          throw new Error('unused');
        },
        updateDoseEventStatusAsync: async () => createEmptyConnectedCrmState(),
        addLabResultAsync: async () => createEmptyConnectedCrmState(),
        addFollowUpAsync: async () => createEmptyConnectedCrmState(),
        updateFollowUpStatusAsync: async () => createEmptyConnectedCrmState(),
        addFollowUpContactLogAsync: async () => createEmptyConnectedCrmState(),
        sendConsultationReplyAsync: async () => createEmptyConnectedCrmState(),
        updateConsultationStatusAsync: async () => createEmptyConnectedCrmState(),
        issueInvitationAsync: async () => {
          throw new Error('unused');
        },
        revokeInvitationAsync: async () => createEmptyConnectedCrmState(),
      }),
    });

    await h.controller.restoreInitialSession();
    assert.equal(h.snapshot().authStatus, 'unauthorized');
    assert.equal(h.snapshot().repo, null);
    assert.equal(h.snapshot().state.patients.length, 0);
    assert.equal(h.snapshot().selectedPatientId, null);
    assert.equal(sim.getUserId(), null);
    h.controller.dispose();
    console.log('✓ S8. Session revoked during hydration immediately clears workspace & signs out');
  }

  // S9, S10, S11, S12. Rapid sign-out, account switch A -> B, delayed A response & stale A error
  {
    const sim = new TenantEnforcingClientSimulator(db, null);
    const delayedHydrationA = createDeferred<CrmState>();
    let useDelayedForA = true;

    const h = makeControllerHarness({
      client: sim.asSupabaseClient(),
      createRepository: (c, ctx) => {
        if (ctx.pharmacyId === PHARMACY_A_ID && useDelayedForA) {
          return {
            mode: 'supabase_stage2',
            getStateAsync: () => delayedHydrationA.promise,
            resetAsync: async () => createEmptyConnectedCrmState(),
            setActiveStaffAsync: async () => createEmptyConnectedCrmState(),
            addPatientAsync: async () => {
              throw new Error('unused');
            },
            updatePatientAsync: async () => createEmptyConnectedCrmState(),
            archivePatientAsync: async () => createEmptyConnectedCrmState(),
            restorePatientAsync: async () => createEmptyConnectedCrmState(),
            addMedicationPlanAsync: async () => {
              throw new Error('unused');
            },
            updateMedicationPlanAsync: async () => createEmptyConnectedCrmState(),
            changeMedicationStatusAsync: async () => createEmptyConnectedCrmState(),
            recordDispensingAsync: async () => {
              throw new Error('unused');
            },
            updateDoseEventStatusAsync: async () => createEmptyConnectedCrmState(),
            addLabResultAsync: async () => createEmptyConnectedCrmState(),
            addFollowUpAsync: async () => createEmptyConnectedCrmState(),
            updateFollowUpStatusAsync: async () => createEmptyConnectedCrmState(),
            addFollowUpContactLogAsync: async () => createEmptyConnectedCrmState(),
            sendConsultationReplyAsync: async () => createEmptyConnectedCrmState(),
            updateConsultationStatusAsync: async () => createEmptyConnectedCrmState(),
            issueInvitationAsync: async () => {
              throw new Error('unused');
            },
            revokeInvitationAsync: async () => createEmptyConnectedCrmState(),
          };
        }
        return new SupabaseCrmRepository(c as SupabaseClient, ctx);
      },
    });

    // Sign in A -> hydration hangs in flight
    const signInAPromise = h.controller.signIn('owner-a@masar.test', 'SecretPasswordA!');
    // Let sign-in reach hydration wait
    await new Promise((r) => setTimeout(r, 15));
    const genA = h.controller.getCoordinator().getCurrentGeneration();
    h.snapshot().setSelectedPatientId(PATIENT_A1_ID);

    // Rapid sign-out while A is still hydrating
    await h.controller.signOut();
    assert.equal(h.snapshot().authStatus, 'unauthenticated');
    assert.equal(h.snapshot().selectedPatientId, null);
    assert.equal(h.snapshot().state.patients.length, 0);

    // Now switch straight into Pharmacy B in the same browser session
    await h.controller.signIn('owner-b@masar.test', 'SecretPasswordB!');
    assert.equal(h.snapshot().authStatus, 'authenticated');
    assert.equal(h.snapshot().pharmacist?.userId, OWNER_B_ID);
    assert.equal(h.snapshot().state.pharmacy.id, PHARMACY_B_ID);

    // Now delayed Pharmacy A hydration finally resolves with Pharmacy A data — MUST BE IGNORED
    delayedHydrationA.resolve(await repoA.getStateAsync());
    await signInAPromise;

    assert.equal(h.snapshot().authStatus, 'authenticated');
    assert.equal(h.snapshot().pharmacist?.userId, OWNER_B_ID);
    assert.equal(h.snapshot().state.pharmacy.id, PHARMACY_B_ID);
    assert.deepEqual(
      h.snapshot().state.patients.map((p) => p.id),
      [PATIENT_B1_ID],
      'Delayed Pharmacy A response must NEVER overwrite Pharmacy B workspace'
    );

    // Also verify a delayed stale runtime error from Pharmacy A's superseded operation NEVER revokes Pharmacy B
    const handledStaleErr = await h.controller.handleRuntimeError(
      new ConnectedAuthorizationError('STAFF_INACTIVE', 'Stale Pharmacy A revocation'),
      { expectedGeneration: genA, expectedUserId: OWNER_A_ID }
    );
    assert.equal(handledStaleErr, false, 'Stale error from User A must be ignored');
    assert.equal(h.snapshot().authStatus, 'authenticated');
    assert.equal(h.snapshot().state.pharmacy.id, PHARMACY_B_ID);

    // Direct switch A -> B without explicit signOut first (tests intermediate SIGNED_OUT during signIn)
    useDelayedForA = false;
    await h.controller.signIn('owner-a@masar.test', 'SecretPasswordA!');
    assert.equal(h.snapshot().state.pharmacy.id, PHARMACY_A_ID);
    h.snapshot().setSelectedPatientId(PATIENT_A1_ID);

    await h.controller.signIn('staff-b@masar.test', 'SecretPasswordB2!');
    assert.equal(h.snapshot().authStatus, 'authenticated');
    assert.equal(h.snapshot().pharmacist?.userId, STAFF_B_ID);
    assert.equal(h.snapshot().state.pharmacy.id, PHARMACY_B_ID);
    assert.equal(
      h.snapshot().selectedPatientId,
      null,
      'Switching accounts must clear previous selectedPatientId'
    );

    // Sign-out clears all sensitive state & selectedPatientId
    h.snapshot().setSelectedPatientId(PATIENT_B1_ID);
    await h.controller.signOut();
    assert.equal(h.snapshot().authStatus, 'unauthenticated');
    assert.equal(h.snapshot().repo, null);
    assert.equal(h.snapshot().pharmacist, null);
    assert.equal(h.snapshot().selectedPatientId, null);
    assert.equal(h.snapshot().state.pharmacy.id, '');
    assert.equal(h.snapshot().state.patients.length, 0);
    assert.equal(h.snapshot().state.medicationPlans.length, 0);
    assert.equal(h.snapshot().state.dispensingEvents.length, 0);
    assert.equal(h.snapshot().state.followUps.length, 0);
    assert.equal(h.snapshot().state.consultations.length, 0);
    assert.equal(h.snapshot().state.auditLogs.length, 0);

    h.controller.dispose();
    console.log(
      '✓ S9-S12. Rapid sign-out, A->B switch, delayed A response/error isolation, and sign-out cleanup verified'
    );
  }

  // ==========================================================================
  // PART 3: STAGE 2C.1 LIVE SQL SPEC STATIC SCHEMA, ACL MATRIX & SAFETY CHECKS
  // ==========================================================================
  {
    const sqlSpecPath = path.resolve(
      process.cwd(),
      'supabase/tests/stage2c1_two_tenant_isolation_spec.sql'
    );
    const checklistPath = path.resolve(
      process.cwd(),
      'supabase/tests/stage2c1_read_only_preflight_and_postcheck.sql'
    );

    const sqlSpec = fs.readFileSync(sqlSpecPath, 'utf8');
    const checklistSql = fs.readFileSync(checklistPath, 'utf8');

    // 1. Transaction & collision-guard safety invariants
    assert.match(sqlSpec, /^BEGIN;/m, 'SQL spec must start inside BEGIN;');
    assert.match(sqlSpec, /\nROLLBACK;\s*$/m, 'SQL spec must end with ROLLBACK;');
    assert.doesNotMatch(sqlSpec, /\bCOMMIT\s*;/i, 'SQL spec must never COMMIT test fixtures');
    assert.match(sqlSpec, /PRE-SEED COLLISION DETECTED/i, 'SQL spec must include pre-seed collision guard');

    // 2. Static ACL / Column-ACL / Forced RLS / RPC EXECUTE verification block must exist
    assert.match(sqlSpec, /0B\. STATIC ACL, FORCED-RLS & RPC EXECUTE PRIVILEGE MATRIX VERIFICATION/);
    assert.match(sqlSpec, /relrowsecurity IS NOT TRUE OR c\.relforcerowsecurity IS NOT TRUE/);
    assert.match(sqlSpec, /has_table_privilege\('anon'/);
    assert.match(sqlSpec, /has_table_privilege\('authenticated', 'public\.pharmacies', 'UPDATE'\)/);
    assert.match(sqlSpec, /has_table_privilege\('authenticated', 'public\.pharmacy_staff', 'UPDATE'\)/);
    assert.match(sqlSpec, /has_table_privilege\('authenticated', 'public\.patients', 'UPDATE'\)/);
    assert.match(sqlSpec, /has_column_privilege\('authenticated', 'public\.patients', 'clinical_notes', 'UPDATE'\)/);
    assert.match(sqlSpec, /has_table_privilege\('authenticated', 'public\.follow_up_tasks', 'UPDATE'\)/);
    assert.match(sqlSpec, /COLUMN ACL MATRIX FAILURE/);
    assert.match(sqlSpec, /has_column_privilege\('authenticated', 'public\.pharmacies', 'phone', 'UPDATE'\)/);
    assert.match(sqlSpec, /has_column_privilege\('authenticated', 'public\.pharmacies', 'name_en', 'UPDATE'\)/);
    assert.match(sqlSpec, /has_column_privilege\('authenticated', 'public\.pharmacy_staff', 'phone', 'UPDATE'\)/);
    assert.match(sqlSpec, /has_column_privilege\('authenticated', 'public\.pharmacy_staff', 'is_active', 'UPDATE'\)/);
    assert.match(sqlSpec, /has_column_privilege\('authenticated', 'public\.patients', 'status', 'UPDATE'\)/);
    assert.match(sqlSpec, /has_function_privilege\('authenticated', 'public\.update_medication_plan_version/);
    assert.match(sqlSpec, /has_function_privilege\('authenticated', 'public\.redeem_patient_apk_invitation/);

    // Verify `anon` EXECUTE privilege denial covers ALL 10 authenticated clinical/patient RPCs
    const tenAuthenticatedRpcs = [
      'public.create_patient_with_clinical_tags(text,text,text,text,text,date,text,text,text,date,jsonb,jsonb)',
      'public.update_patient_with_clinical_tags(uuid,jsonb,jsonb,jsonb)',
      'public.create_medication_plan_with_version(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb)',
      'public.update_medication_plan_version(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date)',
      'public.change_medication_plan_status(uuid,text,text,date)',
      'public.record_dispensing_with_refill(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb)',
      'public.send_consultation_reply(uuid,text,text)',
      'public.issue_patient_apk_invitation(uuid,text,text,integer,boolean)',
      'public.revoke_patient_apk_invitation(uuid,text)',
      'public.confirm_scheduled_dose(uuid,text,uuid,text)',
    ];
    for (const rpcSig of tenAuthenticatedRpcs) {
      assert.equal(
        sqlSpec.includes(`pg_catalog.has_function_privilege('anon', '${rpcSig}', 'EXECUTE')`),
        true,
        `SQL spec Section 0B missing anon EXECUTE denial check for ${rpcSig}`
      );
      assert.equal(
        sqlSpec.includes(`pg_catalog.has_function_privilege('authenticated', '${rpcSig}', 'EXECUTE')`),
        true,
        `SQL spec Section 0B missing authenticated EXECUTE grant check for ${rpcSig}`
      );
    }

    // Verify Stage 2C.2B capability & _v2 RPCs are checked conditionally via to_regprocedure
    const stage2c2bRpcs = [
      'public.get_clinical_safety_capabilities()',
      'public.create_medication_plan_with_version_v2(uuid,uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,jsonb)',
      'public.update_medication_plan_version_v2(uuid,text,text,text,text,text,numeric,text,text,text,text,text,date,date,boolean,integer,jsonb,text,date,integer,jsonb)',
      'public.record_dispensing_with_refill_v2(uuid,uuid,numeric,text,integer,numeric,text,date,date,boolean,text,numeric,integer,date,text,numeric,numeric,integer,text,date,text,text,text,jsonb,integer,uuid,text,jsonb)',
    ];
    for (const v2Sig of stage2c2bRpcs) {
      assert.equal(
        sqlSpec.includes(`'${v2Sig}'`),
        true,
        `SQL spec missing conditional Stage 2C.2B signature ${v2Sig}`
      );
    }
    assert.match(sqlSpec, /pg_catalog\.to_regprocedure\(v_v2_sig\) IS NOT NULL/);
    assert.match(sqlSpec, /pg_catalog\.has_function_privilege\('anon', v_v2_sig, 'EXECUTE'\)/);
    assert.match(sqlSpec, /pg_catalog\.has_function_privilege\('authenticated', v_v2_sig, 'EXECUTE'\)/);

    // 2B. Regression assertion: unscheduled_dose_reports report_type MUST be compatible
    // with the referenced medication plan's schedule.frequencyType (`enforce_unscheduled_dose_report_provenance()`).
    // Specifically, `v_plan_a1` and `v_plan_b1` both use `"frequencyType":"daily"`, so `'prn_intake'` is invalid
    // and raises SQLSTATE 23514 unless the plan is `"frequencyType":"prn"`.
    const schedAMatch = sqlSpec.match(/v_sched_json_a\s+constant\s+jsonb\s*:=\s*'([^']+)'::jsonb/);
    const schedBMatch = sqlSpec.match(/v_sched_json_b\s+constant\s+jsonb\s*:=\s*'([^']+)'::jsonb/);
    assert.ok(schedAMatch && schedBMatch, 'Expected v_sched_json_a and v_sched_json_b definitions in SQL spec');
    const schedA = JSON.parse(schedAMatch[1]) as { frequencyType: string };
    const schedB = JSON.parse(schedBMatch[1]) as { frequencyType: string };
    assert.equal(schedA.frequencyType, 'daily', 'Plan A1 must remain daily for dispensing/refill/scheduled-dose tests');
    assert.equal(schedB.frequencyType, 'daily', 'Plan B1 must remain daily for dispensing/refill/scheduled-dose tests');

    const doseReportInserts = [
      ...sqlSpec.matchAll(/INSERT\s+INTO\s+public\.unscheduled_dose_reports\s*\([^)]*\)\s*VALUES\s*([\s\S]*?);/gi),
    ];
    assert.ok(doseReportInserts.length >= 3, 'Expected initial seed and patient unscheduled_dose_reports inserts');
    for (const insertMatch of doseReportInserts) {
      const valuesBlock = insertMatch[1];
      const tupleMatches = [...valuesBlock.matchAll(/\(((?:[^()]+|\([^()]*\))+)\)/g)];
      assert.ok(tupleMatches.length >= 1, 'Expected row tuple inside unscheduled_dose_reports INSERT');
      for (const tuple of tupleMatches) {
        const rowText = tuple[1];
        const targetsPlanA =
          rowText.includes('v_plan_a1') || rowText.includes('2c10a301-0000-4000-8000-000000000001');
        const targetsPlanB =
          rowText.includes('v_plan_b1') || rowText.includes('2c10b301-0000-4000-8000-000000000001');
        const targetFreq: string | null = targetsPlanA
          ? schedA.frequencyType
          : targetsPlanB
            ? schedB.frequencyType
            : null;
        assert.ok(targetFreq, `Unrecognized plan reference in unscheduled_dose_reports row: ${rowText}`);
        const reportTypeMatch = rowText.match(/'(prn_intake|unscheduled_extra|missed_dose_recovery)'/);
        assert.ok(reportTypeMatch, `Missing valid report_type in unscheduled_dose_reports row: ${rowText}`);
        if (reportTypeMatch[1] === 'prn_intake') {
          assert.equal(
            targetFreq,
            'prn',
            `report_type 'prn_intake' is incompatible with frequencyType='${targetFreq}' (trigger 23514): ${rowText}`
          );
        }
      }
    }
    assert.match(
      sqlSpec,
      /\(v_pharm_a,\s*v_patient_a1,\s*v_plan_a1,\s*'unscheduled_extra'[\s\S]*\(v_pharm_b,\s*v_patient_b1,\s*v_plan_b1,\s*'unscheduled_extra'/
    );

    // 2C. Cross-patient unscheduled_dose_reports insert test MUST accept 42501 OR strictly message-guarded 23514
    const crossPatientDoseBlockMatch = sqlSpec.match(
      /BEGIN\s+INSERT\s+INTO\s+public\.unscheduled_dose_reports[\s\S]*?2c10b301-0000-4000-8000-000000000001[\s\S]*?END;/
    );
    assert.ok(
      crossPatientDoseBlockMatch,
      'Expected Patient A1 cross-patient unscheduled_dose_reports negative test block'
    );
    const crossPatientDoseBlock = crossPatientDoseBlockMatch[0];
    assert.match(
      crossPatientDoseBlock,
      /RAISE EXCEPTION 'Patient A1 inserted unscheduled_dose_reports for Patient B1\.';/
    );
    assert.match(
      crossPatientDoseBlock,
      /WHEN\s+SQLSTATE\s+'42501'\s+THEN\s+NULL;/i,
      'Cross-patient unscheduled_dose_reports block must accept RLS denial SQLSTATE 42501'
    );
    assert.match(
      crossPatientDoseBlock,
      /WHEN\s+SQLSTATE\s+'23514'\s+THEN[\s\S]*?IF\s+SQLERRM\s+NOT\s+LIKE\s+'Clinical provenance violation: unscheduled dose reports require an active medication plan for the same patient\/pharmacy\.%'\s+THEN\s+RAISE;\s+END\s+IF;/i,
      'Cross-patient unscheduled_dose_reports 23514 handler must strictly check exact clinical-provenance error message and re-raise any other 23514 error'
    );
    assert.doesNotMatch(
      crossPatientDoseBlock,
      /WHEN\s+SQLSTATE\s+'23514'\s+THEN\s+NULL;/i,
      'Cross-patient unscheduled_dose_reports block must NEVER unconditionally swallow SQLSTATE 23514'
    );

    // 2D. Forged consultation approval assertion MUST accept 42501 OR SQLSTATE 23514 strictly
    // when CONSTRAINT_NAME = 'chk_consultation_messages_patient_unapproved', re-raising any other 23514.
    const patientSectionMatch = sqlSpec.match(
      /-- 6\. PATIENT A VS PATIENT B:[\s\S]*?(?=-- 7\. FINAL SESSION CONTEXT HYGIENE)/
    );
    assert.ok(patientSectionMatch, 'Expected Section 6 (Patient A vs Patient B) block in SQL spec');
    assert.match(
      patientSectionMatch[0],
      /v_constraint_name\s+text;/,
      'Section 6 must declare v_constraint_name text for GET STACKED DIAGNOSTICS'
    );

    const forgedApprovalBlockMatch = sqlSpec.match(
      /BEGIN\s+INSERT\s+INTO\s+public\.consultation_messages\s*\([^)]*approved_by_pharmacist[^)]*\)\s*VALUES\s*\([^;]*'Forged approval',\s*true\s*\);[\s\S]*?END;/i
    );
    assert.ok(
      forgedApprovalBlockMatch,
      'Expected Patient A1 forged consultation approval negative test block'
    );
    const forgedApprovalBlock = forgedApprovalBlockMatch[0];
    assert.match(
      forgedApprovalBlock,
      /RAISE EXCEPTION 'Patient A1 forged approved_by_pharmacist=true\.';/
    );
    assert.match(
      forgedApprovalBlock,
      /WHEN\s+SQLSTATE\s+'42501'\s+THEN\s+NULL;/i,
      'Forged consultation approval block must accept RLS denial SQLSTATE 42501'
    );
    assert.match(
      forgedApprovalBlock,
      /WHEN\s+SQLSTATE\s+'23514'\s+THEN[\s\S]*?GET\s+STACKED\s+DIAGNOSTICS\s+v_constraint_name\s*=\s*CONSTRAINT_NAME;[\s\S]*?IF\s+v_constraint_name\s+IS\s+DISTINCT\s+FROM\s+'chk_consultation_messages_patient_unapproved'\s+THEN\s+RAISE;\s+END\s+IF;/i,
      'Forged consultation approval 23514 handler must verify CONSTRAINT_NAME = chk_consultation_messages_patient_unapproved and re-raise any other constraint failure'
    );
    assert.doesNotMatch(
      forgedApprovalBlock,
      /WHEN\s+SQLSTATE\s+'23514'\s+THEN\s+NULL;/i,
      'Forged consultation approval block must NEVER unconditionally swallow SQLSTATE 23514'
    );

    // 3. Distinguish revoked-column/revoked-table ACL denials (42501) from column-granted RLS filtering (ROW_COUNT)
    // 3a. `patients` (ungranted `clinical_notes`), `patient_medication_plans`, and `audit_logs` have no UPDATE grant
    // for those columns/tables -> EVERY direct UPDATE must expect SQLSTATE '42501' and NOT rely on ROW_COUNT.
    const revokedDirectUpdateRegex =
      /UPDATE\s+public\.(patients|patient_medication_plans|audit_logs)\b[\s\S]{0,220}?;/gi;
    const revokedUpdateMatches = [...sqlSpec.matchAll(revokedDirectUpdateRegex)];
    assert.ok(
      revokedUpdateMatches.length >= 9,
      `Expected at least 9 revoked/ungranted-column direct UPDATE ACL negative probes, got ${revokedUpdateMatches.length}`
    );
    for (const match of revokedUpdateMatches) {
      const idx = match.index ?? 0;
      const endIdx = sqlSpec.indexOf('END;', idx);
      assert.notEqual(
        endIdx,
        -1,
        `Direct UPDATE on ACL-revoked table/column (${match[1]}) must be enclosed in BEGIN...EXCEPTION...END;`
      );
      const enclosingBlock = sqlSpec.slice(idx, endIdx + 4);
      assert.match(
        enclosingBlock,
        /EXCEPTION\s+WHEN\s+SQLSTATE\s+'42501'\s+THEN\s+NULL;/i,
        `Direct UPDATE on ACL-revoked table/column (${match[1]}) must expect SQLSTATE 42501: ${match[0]}`
      );
      assert.doesNotMatch(
        enclosingBlock,
        /GET\s+DIAGNOSTICS\s+v_cnt\s*=\s*ROW_COUNT/i,
        `Direct UPDATE on ACL-revoked table/column (${match[1]}) must NOT rely on ROW_COUNT`
      );
    }

    // 3b. `pharmacies` and `pharmacy_staff` HAVE narrow column-level UPDATE grants (`phone`, `is_active`, etc.),
    // so PostgreSQL enforces owner/tenant authorization via RLS:
    //   - Same-pharmacy Owner A/B updates succeed with ROW_COUNT = 1 (4 probes)
    //   - Cross-tenant Owner / Pharmacist / Inactive Staff updates are RLS-filtered to ROW_COUNT = 0 (9 probes)
    const columnGrantedUpdateRegex =
      /UPDATE\s+public\.(pharmacies|pharmacy_staff)\s+SET\s+(phone|is_active)\s*=[\s\S]{0,220}?;/gi;
    const columnGrantedMatches = [...sqlSpec.matchAll(columnGrantedUpdateRegex)];
    assert.equal(
      columnGrantedMatches.length,
      13,
      `Expected 13 column-granted direct UPDATE probes on pharmacies/pharmacy_staff, got ${columnGrantedMatches.length}`
    );
    let ownOwnerRowCountOneProbes = 0;
    let rlsFilteredRowCountZeroProbes = 0;
    for (const match of columnGrantedMatches) {
      const idx = match.index ?? 0;
      const snippet = sqlSpec.slice(idx, idx + 320);
      assert.match(
        snippet,
        /GET\s+DIAGNOSTICS\s+v_cnt\s*=\s*ROW_COUNT;/i,
        `Column-granted UPDATE on ${match[1]}.${match[2]} must inspect ROW_COUNT: ${match[0]}`
      );
      if (/IF\s+v_cnt\s*<>\s*1\s+THEN\s+RAISE\s+EXCEPTION/i.test(snippet)) {
        ownOwnerRowCountOneProbes += 1;
      } else if (/IF\s+v_cnt\s*<>\s*0\s+THEN\s+RAISE\s+EXCEPTION/i.test(snippet)) {
        rlsFilteredRowCountZeroProbes += 1;
      } else {
        assert.fail(`Column-granted UPDATE missing ROW_COUNT = 1 or ROW_COUNT = 0 assertion: ${match[0]}`);
      }
    }
    assert.equal(ownOwnerRowCountOneProbes, 4, 'Expected 4 same-pharmacy Owner ROW_COUNT = 1 probes (pharmacies + pharmacy_staff for A & B)');
    assert.equal(rlsFilteredRowCountZeroProbes, 9, 'Expected 9 RLS-filtered ROW_COUNT = 0 probes (cross-tenant owners, pharmacists, inactive staff)');

    // 3c. `follow_up_tasks` DOES grant UPDATE to `authenticated` -> positive own-pharmacy checks ROW_COUNT = 1,
    // negative cross-tenant/non-staff `authenticated` checks ROW_COUNT = 0, and `anon` checks 42501.
    assert.match(
      sqlSpec,
      /UPDATE public\.follow_up_tasks[\s\S]{0,220}IF v_cnt <> 1 THEN RAISE EXCEPTION 'Owner A positive update on own follow_up_tasks failed/
    );
    assert.match(
      sqlSpec,
      /UPDATE public\.follow_up_tasks[\s\S]{0,220}IF v_cnt <> 0 THEN RAISE EXCEPTION 'Owner A modified Pharmacy B follow-up/
    );
    assert.match(
      sqlSpec,
      /UPDATE public\.follow_up_tasks[\s\S]{0,220}IF v_cnt <> 0 THEN RAISE EXCEPTION 'Owner B modified Pharmacy A follow-up/
    );
    assert.match(
      sqlSpec,
      /UPDATE public\.follow_up_tasks[\s\S]{0,220}RAISE EXCEPTION 'anon role updated public\.follow_up_tasks\.';\s*EXCEPTION WHEN SQLSTATE '42501' THEN NULL;/
    );

    // 4. Forbidden legacy invalid enum / column values from earlier draft must be absent
    const forbiddenLiterals = [
      'no_restriction',
      'refill_due',
      'verification_method',
      "'reached'",
      "'adequate'",
      "'unverified'",
      'hash-a-2c1',
      'hash-b-2c1',
    ];
    for (const bad of forbiddenLiterals) {
      assert.equal(
        sqlSpec.includes(bad),
        false,
        `SQL spec must not contain invalid schema/fixture literal: ${bad}`
      );
    }
    // follow_up_contact_logs.channel must use whatsapp_manual (only patients.contact_preference uses 'whatsapp')
    assert.match(sqlSpec, /'whatsapp_manual'/);
    assert.doesNotMatch(
      sqlSpec,
      /INSERT INTO public\.follow_up_contact_logs[^;]*'whatsapp'/i,
      'follow_up_contact_logs must use whatsapp_manual'
    );

    // 5. Corrected valid schema literals & columns must be present
    const requiredTokens = [
      "'any_time'",
      "'refill'",
      "'whatsapp_manual'",
      "'answered'",
      "'on_track'",
      "'provisional_unverified'",
      'recorded_by_staff_id',
      'quantity_unit',
      'pharmacist_pin_hash',
      "encode(extensions.digest('masar-2c10-invite-token-a2', 'sha256'), 'hex')",
      "encode(extensions.digest('masar-2c10-invite-token-b2', 'sha256'), 'hex')",
      'instance_id',
      'encrypted_password',
      'email_confirmed_at',
      'raw_app_meta_data',
      'public.unscheduled_dose_reports',
      'public.invitation_redemption_attempts',
    ];
    for (const token of requiredTokens) {
      assert.equal(sqlSpec.includes(token), true, `SQL spec missing required schema element: ${token}`);
    }

    // 6. Auth context checks & exact non-privileged role execution
    assert.match(sqlSpec, /SET LOCAL ROLE authenticated;/);
    assert.match(sqlSpec, /SET LOCAL ROLE anon;/);
    assert.match(sqlSpec, /current_user <> 'authenticated' OR auth\.uid\(\) IS DISTINCT FROM/);
    assert.match(sqlSpec, /current_user <> 'anon' OR auth\.uid\(\) IS NOT NULL/);

    // 7. All 8 required actor scenarios represented
    const requiredActorHeaders = [
      'OWNER A SESSION',
      'OWNER B SESSION',
      'PHARMACIST A & PHARMACIST B',
      'INACTIVE STAFF',
      'UNLINKED AUTHENTICATED USER',
      'Anonymous Role (`anon`)',
      'PATIENT A VS PATIENT B',
    ];
    for (const header of requiredActorHeaders) {
      assert.equal(sqlSpec.includes(header), true, `SQL spec missing scenario section: ${header}`);
    }

    // 8. Negative tests must assert specific SQLSTATEs, never bare WHEN OTHERS THEN NULL or unguarded 23514
    assert.doesNotMatch(
      sqlSpec,
      /WHEN\s+OTHERS\s+THEN\s+NULL/i,
      'SQL spec must never swallow arbitrary errors with WHEN OTHERS THEN NULL'
    );
    assert.doesNotMatch(
      sqlSpec,
      /WHEN\s+SQLSTATE\s+'23514'\s+THEN\s+NULL;/i,
      'SQL spec must never unconditionally swallow SQLSTATE 23514 without verifying exact constraint or message'
    );
    assert.match(sqlSpec, /EXCEPTION WHEN SQLSTATE '42501' THEN NULL;/);
    assert.match(sqlSpec, /EXCEPTION WHEN SQLSTATE '23503' THEN NULL;/);

    // 9. Read-only preflight/post-test checklist must remain strictly SELECT-only and cover all 24 tables + auth.users
    assert.doesNotMatch(
      checklistSql,
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i,
      'Preflight/postcheck SQL checklist must be strictly read-only SELECT statements'
    );
    assert.match(checklistSql, /count-and-selected-field comparisons/i);
    assert.match(checklistSql, /DEV-TEST-001/);
    assert.match(checklistSql, /2c10%/);
    const checklistRequiredTables = [
      'auth.users',
      'public.pharmacies',
      'public.pharmacy_staff',
      'public.patients',
      'public.patient_conditions',
      'public.patient_allergies',
      'public.medication_catalog',
      'public.patient_medication_plans',
      'public.regimen_versions',
      'public.medication_pause_periods',
      'public.scheduled_doses',
      'public.dose_events',
      'public.unscheduled_dose_reports',
      'public.dispensing_events',
      'public.refill_assessments',
      'public.lab_results',
      'public.follow_up_tasks',
      'public.follow_up_contact_logs',
      'public.consultation_threads',
      'public.consultation_messages',
      'public.patient_apk_invitations',
      'public.invitation_redemption_attempts',
      'public.audit_logs',
      'public.bootstrap_state',
      'public.staff_provisioning_requests',
    ];
    for (const tbl of checklistRequiredTables) {
      assert.equal(
        checklistSql.includes(tbl),
        true,
        `Preflight/postcheck SQL checklist missing baseline/rollback table coverage: ${tbl}`
      );
    }

    console.log('✓ P3. Stage 2C.1 live SQL spec column-ACL, RLS ROW_COUNT, guarded-23514/42501, 10-RPC anon denials, and 24-table checklist checks passed');
  }

  console.log('ALL STAGE 2C.1 / 2C.1C LOCAL MULTI-TENANT & SQL SPEC CHECKS PASSED.');
}

runTests().catch((err) => {
  console.error('Stage 2C.1 test suite failed:', err);
  process.exit(1);
});
