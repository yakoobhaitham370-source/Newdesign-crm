import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthenticatedPharmacistContext } from '../services/authService';
import {
  AllergyPersistenceVerificationError,
  buildAllergiesRpcPayload,
  createLocalAllergyId,
  getBilingualAllergyVerificationMessage,
  isAllergyPersistenceVerificationError,
  resolveAllergiesForSubmit,
  validateAndAddAllergyToList,
  verifyPersistedAllergies,
} from '../services/patientAllergyHelpers';
import { SupabaseCrmRepository } from '../services/supabaseCrmRepository';
import type { PatientAllergy } from '../types/domain';

const PHARMACY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PATIENT_ID = '33333333-3333-4333-8333-333333333333';

function makeAuthContext(): AuthenticatedPharmacistContext {
  return {
    userId: USER_ID,
    email: 'masar-care-dev-owner@example.com',
    pharmacyId: PHARMACY_ID,
    role: 'pharmacy_owner',
    staff: {
      id: USER_ID,
      pharmacyId: PHARMACY_ID,
      fullName: 'د. الصيدلي الموثق',
      role: 'pharmacy_owner',
      phone: '07701234567',
      isActive: true,
    },
    pharmacy: {
      id: PHARMACY_ID,
      nameAr: 'صيدلية مسار التطويرية',
      nameEn: 'MASAR Dev Pharmacy',
      city: 'بغداد',
      governorate: 'بغداد',
      licenseNumber: 'IQ-DEV-101',
      phone: '07701234567',
      timezone: 'Asia/Baghdad',
    },
  };
}

interface MockPatientAllergyRow extends Record<string, unknown> {
  id: string;
  pharmacy_id: string;
  patient_id: string;
  substance: string;
  severity: 'mild' | 'moderate' | 'severe';
  reaction: string | null;
  status: 'active' | 'inactive';
}

function makeAllergySupabaseHarness(options: {
  initialPatients?: Array<Record<string, unknown>>;
  initialConditions?: Array<Record<string, unknown>>;
  initialAllergies?: MockPatientAllergyRow[];
  dropAllergiesOnRpc?: boolean;
  corruptAllergyOnRpc?: boolean;
  extraUnexpectedAllergyOnRpc?: boolean;
  rpcError?: { code?: string; message: string; details?: string; hint?: string } | null;
} = {}) {
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const tables: Record<string, Array<Record<string, unknown>>> = {
    pharmacy_staff: [
      {
        id: USER_ID,
        pharmacy_id: PHARMACY_ID,
        full_name: 'د. الصيدلي الموثق',
        role: 'pharmacy_owner',
        syndicate_license: 'SYND-101',
        phone: '07701234567',
        is_active: true,
      },
    ],
    patients: options.initialPatients ? [...options.initialPatients] : [],
    patient_conditions: options.initialConditions ? [...options.initialConditions] : [],
    patient_allergies: options.initialAllergies ? [...options.initialAllergies] : [],
    patient_medication_plans: [],
    regimen_versions: [],
    medication_pause_periods: [],
    dispensing_events: [],
    dose_events: [],
    lab_results: [],
    follow_up_tasks: [],
    follow_up_contact_logs: [],
    consultation_threads: [],
    consultation_messages: [],
    patient_apk_invitations: [],
    audit_logs: [],
  };

  let seq = 1;

  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              const chain = {
                order() {
                  return chain;
                },
                range(from: number, to: number) {
                  const rows = tables[table] ?? [];
                  return Promise.resolve({
                    data: rows.slice(from, to + 1),
                    error: null,
                  });
                },
                maybeSingle() {
                  if (table === 'pharmacies') {
                    return Promise.resolve({
                      data: {
                        id: PHARMACY_ID,
                        name_ar: 'صيدلية مسار التطويرية',
                        name_en: 'MASAR Dev Pharmacy',
                        city: 'بغداد',
                        governorate: 'بغداد',
                        license_number: 'IQ-DEV-101',
                        phone: '07701234567',
                        timezone: 'Asia/Baghdad',
                        is_active: true,
                      },
                      error: null,
                    });
                  }
                  const rows = tables[table] ?? [];
                  return Promise.resolve({ data: rows[0] ?? null, error: null });
                },
              };
              return chain;
            },
          };
        },
      };
    },
    async rpc(fn: string, params: Record<string, unknown>) {
      rpcCalls.push({ fn, params });
      if (options.rpcError) {
        return { data: null, error: options.rpcError };
      }

      if (fn === 'create_patient_with_clinical_tags') {
        const patientId = PATIENT_ID;
        tables.patients.push({
          id: patientId,
          patient_code: params.p_patient_code,
          pharmacy_id: PHARMACY_ID,
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

        const conditions = (params.p_chronic_conditions as string[]) ?? [];
        for (const cond of conditions) {
          seq += 1;
          tables.patient_conditions.push({
            id: `cond-${seq}`,
            pharmacy_id: PHARMACY_ID,
            patient_id: patientId,
            condition_name: cond,
            status: 'active',
          });
        }

        if (!options.dropAllergiesOnRpc) {
          const allergies =
            (params.p_allergies as Array<{
              substance: string;
              severity: 'mild' | 'moderate' | 'severe';
              reaction: string | null;
            }>) ?? [];
          for (const alg of allergies) {
            seq += 1;
            tables.patient_allergies.push({
              id: `alg-db-${seq}`,
              pharmacy_id: PHARMACY_ID,
              patient_id: patientId,
              substance: alg.substance,
              severity: options.corruptAllergyOnRpc ? 'mild' : alg.severity,
              reaction: alg.reaction,
              status: 'active',
            });
          }
          if (options.extraUnexpectedAllergyOnRpc) {
            seq += 1;
            tables.patient_allergies.push({
              id: `alg-db-extra-${seq}`,
              pharmacy_id: PHARMACY_ID,
              patient_id: patientId,
              substance: 'Sulfa',
              severity: 'moderate',
              reaction: null,
              status: 'active',
            });
          }
        }

        return { data: { ok: true, patientId }, error: null };
      }

      if (fn === 'update_patient_with_clinical_tags') {
        const patientId = String(params.p_patient_id);
        const existing = tables.patients.find((p) => p.id === patientId);
        if (!existing) {
          return { data: null, error: { code: 'P0001', message: 'Patient not found' } };
        }
        const patch = (params.p_patch as Record<string, unknown>) ?? {};
        Object.assign(existing, patch);

        if (params.p_chronic_conditions !== null && params.p_chronic_conditions !== undefined) {
          tables.patient_conditions = tables.patient_conditions.filter(
            (c) => c.patient_id !== patientId
          );
          for (const cond of params.p_chronic_conditions as string[]) {
            seq += 1;
            tables.patient_conditions.push({
              id: `cond-${seq}`,
              pharmacy_id: PHARMACY_ID,
              patient_id: patientId,
              condition_name: cond,
              status: 'active',
            });
          }
        }

        if (params.p_allergies !== null && params.p_allergies !== undefined && !options.dropAllergiesOnRpc) {
          tables.patient_allergies = tables.patient_allergies.filter(
            (a) => a.patient_id !== patientId
          );
          const allergies = params.p_allergies as Array<{
            substance: string;
            severity: 'mild' | 'moderate' | 'severe';
            reaction: string | null;
          }>;
          for (const alg of allergies) {
            seq += 1;
            tables.patient_allergies.push({
              id: `alg-db-${seq}`,
              pharmacy_id: PHARMACY_ID,
              patient_id: patientId,
              substance: alg.substance,
              severity: options.corruptAllergyOnRpc ? 'mild' : alg.severity,
              reaction: alg.reaction,
              status: 'active',
            });
          }
          if (options.extraUnexpectedAllergyOnRpc) {
            seq += 1;
            tables.patient_allergies.push({
              id: `alg-db-extra-${seq}`,
              pharmacy_id: PHARMACY_ID,
              patient_id: patientId,
              substance: 'Aspirin',
              severity: 'mild',
              reaction: null,
              status: 'active',
            });
          }
        }

        return { data: { ok: true, patientId }, error: null };
      }

      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;

  return { client, rpcCalls, tables };
}

function makeExistingPatientRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PATIENT_ID,
    patient_code: 'DEV-TEST-001',
    pharmacy_id: PHARMACY_ID,
    full_name: 'مراجع اختباري',
    phone: '+9647701234567',
    phone_owner_type: 'self',
    caregiver_name: null,
    date_of_birth: '1975-01-01',
    sex: 'male',
    contact_preference: 'whatsapp',
    clinical_notes: '',
    registration_date: '2026-04-01',
    status: 'active',
    archived_at: null,
    archived_reason: null,
    ...overrides,
  };
}

async function runTests() {
  console.log('=== MASAR Care Stage 2B.5A Allergy Save & Persistence Suite ===');

  // --------------------------------------------------------------------------
  // 1. Allergy entered & saved directly WITHOUT clicking "Add Allergy"
  // --------------------------------------------------------------------------
  {
    const directSubmit = resolveAllergiesForSubmit(
      [],
      { substance: '  Penicillin  ', severity: 'severe', reaction: ' Anaphylaxis ' },
      'en'
    );
    assert.equal(directSubmit.ok, true);
    if (directSubmit.ok) {
      assert.equal(directSubmit.mergedDraft, true);
      assert.equal(directSubmit.allergies.length, 1);
      assert.equal(directSubmit.allergies[0].substance, 'Penicillin');
      assert.equal(directSubmit.allergies[0].severity, 'severe');
      assert.equal(directSubmit.allergies[0].reaction, 'Anaphylaxis');

      const rpcPayload = buildAllergiesRpcPayload(directSubmit.allergies);
      assert.deepEqual(rpcPayload, [
        { substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
      ]);

      const { client, rpcCalls } = makeAllergySupabaseHarness({
        initialPatients: [makeExistingPatientRow()],
        initialConditions: [
          {
            id: 'cond-1',
            pharmacy_id: PHARMACY_ID,
            patient_id: PATIENT_ID,
            condition_name: 'Type 2 diabetes',
            status: 'active',
          },
        ],
      });
      const repo = new SupabaseCrmRepository(client, makeAuthContext());
      const updatedState = await repo.updatePatientAsync(PATIENT_ID, {
        allergies: directSubmit.allergies,
      });

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'update_patient_with_clinical_tags');
      assert.deepEqual(rpcCalls[0].params.p_allergies, [
        { substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
      ]);
      const reloaded = updatedState.patients.find((p) => p.id === PATIENT_ID);
      assert.ok(reloaded);
      assert.equal(reloaded.allergies.length, 1);
      assert.equal(reloaded.allergies[0].substance, 'Penicillin');
      assert.equal(reloaded.allergies[0].severity, 'severe');
      assert.equal(reloaded.allergies[0].reaction, 'Anaphylaxis');
    }
    console.log('✓ 1. Allergy entered and saved directly without pressing Add Allergy');
  }

  // --------------------------------------------------------------------------
  // 2. Clicking "Add Allergy" and then saving
  // --------------------------------------------------------------------------
  {
    const addResult = validateAndAddAllergyToList(
      [],
      { substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
      'en'
    );
    assert.equal(addResult.ok, true);
    if (addResult.ok) {
      const submitResult = resolveAllergiesForSubmit(
        addResult.allergies,
        { substance: '', severity: 'moderate', reaction: '' },
        'en'
      );
      assert.equal(submitResult.ok, true);
      if (submitResult.ok) {
        assert.equal(submitResult.mergedDraft, false);
        assert.equal(submitResult.allergies.length, 1);

        const { client, rpcCalls } = makeAllergySupabaseHarness();
        const repo = new SupabaseCrmRepository(client, makeAuthContext());
        const { state, patient } = await repo.addPatientAsync({
          patientCode: 'DEV-TEST-002',
          fullName: 'مراجع اختباري',
          phone: '07701234567',
          dateOfBirth: '1980-05-05',
          sex: 'female',
          chronicConditions: ['Type 2 diabetes'],
          allergies: submitResult.allergies,
          contactPreference: 'whatsapp',
          clinicalNotes: '',
          registrationDate: '2026-04-01',
        });
        assert.equal(rpcCalls[0].fn, 'create_patient_with_clinical_tags');
        assert.deepEqual(rpcCalls[0].params.p_allergies, [
          { substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
        ]);
        assert.equal(patient.allergies.length, 1);
        assert.equal(state.patients[0].allergies[0].substance, 'Penicillin');
      }
    }
    console.log('✓ 2. Add Allergy button followed by Save persists and verifies');
  }

  // --------------------------------------------------------------------------
  // 3. Editing patient with existing allergies preserves them & modal resets cleanly
  // --------------------------------------------------------------------------
  {
    const existingAllergies: PatientAllergy[] = [
      { id: 'alg-db-1', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
    ];
    const submitSame = resolveAllergiesForSubmit(
      existingAllergies,
      { substance: '', severity: 'moderate', reaction: '' },
      'ar'
    );
    assert.equal(submitSame.ok, true);
    if (submitSame.ok) {
      assert.equal(submitSame.allergies.length, 1);
      assert.equal(submitSame.allergies[0].substance, 'Penicillin');
    }

    const modalSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/components/modals/PatientFormModal.tsx'),
      'utf8'
    );
    assert.equal(
      modalSrc.includes("const initKey = existingPatient?.id ?? '__new__'"),
      true,
      'PatientFormModal must key form resets on open/patient identity'
    );
    assert.equal(
      modalSrc.includes('useEffect(() => {') && modalSrc.includes('lastInitKeyRef.current = initKey'),
      true,
      'PatientFormModal must synchronize state via useEffect on [isOpen, existingPatient] changes'
    );
    console.log('✓ 3. Editing existing allergies & modal open/patient switch state sync verified');
  }

  // --------------------------------------------------------------------------
  // 4. Multiple allergies persisted (existing + added + pending draft)
  // --------------------------------------------------------------------------
  {
    const initial: PatientAllergy[] = [
      { id: 'alg-1', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
    ];
    const step2 = validateAndAddAllergyToList(
      initial,
      { substance: 'Sulfa', severity: 'moderate', reaction: 'Rash' },
      'en'
    );
    assert.equal(step2.ok, true);
    if (step2.ok) {
      const submit = resolveAllergiesForSubmit(
        step2.allergies,
        { substance: 'Ibuprofen', severity: 'mild', reaction: '' },
        'en'
      );
      assert.equal(submit.ok, true);
      if (submit.ok) {
        assert.equal(submit.allergies.length, 3);
        const { client } = makeAllergySupabaseHarness({
          initialPatients: [makeExistingPatientRow()],
          initialAllergies: [
            {
              id: 'alg-db-1',
              pharmacy_id: PHARMACY_ID,
              patient_id: PATIENT_ID,
              substance: 'Penicillin',
              severity: 'severe',
              reaction: 'Anaphylaxis',
              status: 'active',
            },
          ],
        });
        const repo = new SupabaseCrmRepository(client, makeAuthContext());
        const updated = await repo.updatePatientAsync(PATIENT_ID, {
          allergies: submit.allergies,
        });
        const patient = updated.patients.find((p) => p.id === PATIENT_ID);
        assert.ok(patient);
        assert.equal(patient.allergies.length, 3);
        assert.deepEqual(
          patient.allergies.map((a) => ({
            substance: a.substance,
            severity: a.severity,
            reaction: a.reaction ?? null,
          })),
          [
            { substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
            { substance: 'Sulfa', severity: 'moderate', reaction: 'Rash' },
            { substance: 'Ibuprofen', severity: 'mild', reaction: null },
          ]
        );
      }
    }
    console.log('✓ 4. Multiple allergies (existing + added + pending draft) persisted');
  }

  // --------------------------------------------------------------------------
  // 5. Duplicate substances (case-insensitive) & invalid/incomplete drafts rejected
  // --------------------------------------------------------------------------
  {
    const existing: PatientAllergy[] = [
      { id: 'alg-1', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
    ];

    // Case-insensitive duplicate via Add Allergy (EN & AR)
    const dupAddEn = validateAndAddAllergyToList(
      existing,
      { substance: '  penicillin  ', severity: 'mild', reaction: '' },
      'en'
    );
    assert.equal(dupAddEn.ok, false);
    if (!dupAddEn.ok) {
      assert.match(dupAddEn.error, /already in the list/i);
    }

    const dupAddAr = validateAndAddAllergyToList(
      existing,
      { substance: 'PENICILLIN', severity: 'mild', reaction: '' },
      'ar'
    );
    assert.equal(dupAddAr.ok, false);
    if (!dupAddAr.ok) {
      assert.match(dupAddAr.error, /مضافة مسبقاً/);
    }

    // Case-insensitive duplicate left in draft on Save
    const dupSubmit = resolveAllergiesForSubmit(
      existing,
      { substance: 'pEnIcIlLiN', severity: 'severe', reaction: 'Shock' },
      'en'
    );
    assert.equal(dupSubmit.ok, false);

    // Incomplete substance (<2 chars) on Save
    const shortSubmit = resolveAllergiesForSubmit(
      existing,
      { substance: 'P', severity: 'moderate', reaction: '' },
      'en'
    );
    assert.equal(shortSubmit.ok, false);

    // Reaction without substance on Save (must NOT silently drop)
    const reactionOnlyEn = resolveAllergiesForSubmit(
      existing,
      { substance: '', severity: 'moderate', reaction: 'Hives' },
      'en'
    );
    assert.equal(reactionOnlyEn.ok, false);
    const reactionOnlyAr = resolveAllergiesForSubmit(
      existing,
      { substance: '', severity: 'moderate', reaction: 'شرى' },
      'ar'
    );
    assert.equal(reactionOnlyAr.ok, false);

    console.log('✓ 5. Case-insensitive duplicates and incomplete drafts blocked bilingually');
  }

  // --------------------------------------------------------------------------
  // 6. Rapid Add Allergy followed immediately by Save (unique IDs + ref sync)
  // --------------------------------------------------------------------------
  {
    const id1 = createLocalAllergyId();
    const id2 = createLocalAllergyId();
    const id3 = createLocalAllergyId();
    assert.equal(new Set([id1, id2, id3]).size, 3, 'Rapid local allergy IDs must be unique');

    // Simulate rapid synchronous Add Allergy + immediate Save before React re-render
    let allergiesRef: PatientAllergy[] = [];
    let draftRef = { substance: 'Penicillin', severity: 'severe' as const, reaction: 'Anaphylaxis' };

    const added = validateAndAddAllergyToList(allergiesRef, draftRef, 'en');
    assert.equal(added.ok, true);
    if (added.ok) {
      allergiesRef = added.allergies;
      draftRef = { substance: '', severity: 'severe' as const, reaction: '' };
    }
    const immediateSubmit = resolveAllergiesForSubmit(allergiesRef, draftRef, 'en');
    assert.equal(immediateSubmit.ok, true);
    if (immediateSubmit.ok) {
      assert.equal(immediateSubmit.allergies.length, 1);
      assert.equal(immediateSubmit.allergies[0].substance, 'Penicillin');
    }

    const modalSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/components/modals/PatientFormModal.tsx'),
      'utf8'
    );
    assert.equal(
      modalSrc.includes('allergiesRef.current') && modalSrc.includes('allergyDraftRef.current'),
      true,
      'PatientFormModal must synchronize allergies and draft via refs to prevent rapid Add+Save races'
    );
    console.log('✓ 6. Rapid Add Allergy + immediate Save retains entry with unique IDs');
  }

  // --------------------------------------------------------------------------
  // 7. Successful RPC followed by missing/mismatched allergy on authoritative reload
  // --------------------------------------------------------------------------
  {
    // 7a. Missing allergy on reload
    const missingHarness = makeAllergySupabaseHarness({
      initialPatients: [makeExistingPatientRow()],
      dropAllergiesOnRpc: true,
    });
    const missingRepo = new SupabaseCrmRepository(missingHarness.client, makeAuthContext());
    await assert.rejects(
      () =>
        missingRepo.updatePatientAsync(PATIENT_ID, {
          allergies: [
            { id: 'alg-1', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
          ],
        }),
      (err: unknown) => {
        assert.equal(isAllergyPersistenceVerificationError(err), true);
        if (isAllergyPersistenceVerificationError(err)) {
          assert.equal(err.reason, 'missing');
          assert.ok(err.reloadedState);
          assert.equal(err.message.includes('Penicillin'), false, 'Error message must contain zero PHI');
        }
        return true;
      }
    );

    // 7b. Mismatched severity/reaction on reload
    const mismatchHarness = makeAllergySupabaseHarness({
      initialPatients: [makeExistingPatientRow()],
      corruptAllergyOnRpc: true,
    });
    const mismatchRepo = new SupabaseCrmRepository(mismatchHarness.client, makeAuthContext());
    await assert.rejects(
      () =>
        mismatchRepo.updatePatientAsync(PATIENT_ID, {
          allergies: [
            { id: 'alg-1', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
          ],
        }),
      (err: unknown) =>
        isAllergyPersistenceVerificationError(err) && err.reason === 'mismatch'
    );

    // 7c. Unexpected extra allergy row on reload
    const extraCheck = verifyPersistedAllergies(
      [{ id: 'alg-1', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' }],
      [
        { id: 'alg-db-1', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
        { id: 'alg-db-2', substance: 'Aspirin', severity: 'mild' },
      ]
    );
    assert.deepEqual(extraCheck, { ok: false, reason: 'unexpected_count' });

    // 7d. Bilingual verification failure text & modal preserves form on error
    assert.match(getBilingualAllergyVerificationMessage('en'), /kept open/i);
    assert.match(getBilingualAllergyVerificationMessage('ar'), /لم يتم إغلاق النموذج/);

    const crmContextSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/context/CrmContext.tsx'),
      'utf8'
    );
    assert.equal(
      crmContextSrc.includes('isAllergyPersistenceVerificationError(err)') &&
        crmContextSrc.includes('err.reloadedState'),
      true,
      'CrmContext must reconcile authoritative reloadedState while still rejecting mutation'
    );

    console.log('✓ 7. Post-RPC missing/mismatched allergy throws verification error with zero PHI');
  }

  // --------------------------------------------------------------------------
  // 8. RPC failure preserves unsaved form and never closes modal
  // --------------------------------------------------------------------------
  {
    const errHarness = makeAllergySupabaseHarness({
      initialPatients: [makeExistingPatientRow()],
      rpcError: {
        code: '23514',
        message: 'Allergy substance check constraint violated',
      },
    });
    const errRepo = new SupabaseCrmRepository(errHarness.client, makeAuthContext());
    await assert.rejects(
      () =>
        errRepo.updatePatientAsync(PATIENT_ID, {
          allergies: [
            { id: 'alg-1', substance: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
          ],
        }),
      /Allergy substance check constraint violated/i
    );

    const modalSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/components/modals/PatientFormModal.tsx'),
      'utf8'
    );
    const tryStart = modalSrc.indexOf('try {');
    const catchStart = modalSrc.indexOf('} catch (err) {');
    const tryBlock = modalSrc.slice(tryStart, catchStart);
    const catchBlock = modalSrc.slice(catchStart);
    assert.equal(
      tryBlock.includes('await updatePatient(') &&
        tryBlock.indexOf('await updatePatient(') < tryBlock.indexOf('onClose()'),
      true,
      'PatientFormModal must only call onClose() after updatePatient succeeds'
    );
    assert.equal(
      tryBlock.includes('await addPatient(') &&
        tryBlock.indexOf('await addPatient(') < tryBlock.lastIndexOf('onClose()'),
      true,
      'PatientFormModal must only call onClose() after addPatient succeeds'
    );
    assert.equal(
      catchBlock.includes('onClose()'),
      false,
      'PatientFormModal catch block must never close modal or discard unsaved allergies'
    );
    console.log('✓ 8. RPC failure keeps modal open and preserves unsaved allergies/draft');
  }

  console.log('=== Stage 2B.5A Allergy Persistence Suite PASSED (8/8 checks) ===');
}

runTests().catch((err) => {
  console.error('Stage 2B.5A test suite failed:', err);
  process.exit(1);
});
