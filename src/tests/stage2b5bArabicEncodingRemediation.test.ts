import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  containsCorruptedArabicMojibake,
  getAuditLogDisplaySummary,
  reconstructArabicAuditSummary,
} from '../services/auditDisplayHelper';
import {
  areUnitsCompatibleForRefill,
  normalizeClinicalUnitCategory,
} from '../services/scheduleEngine';
import type { AuditLogEntry } from '../types/domain';

function makeAuditEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 'audit-1',
    pharmacyId: '11111111-1111-4111-8111-111111111111',
    timestamp: '2026-11-14T12:00:00Z',
    actorName: 'د. الصيدلي الموثق',
    actorRole: 'pharmacy_owner',
    action: 'PATIENT_UPDATED',
    entityType: 'patient',
    entityId: '33333333-3333-4333-8333-333333333333',
    summaryAr: 'ØªØ­Ø¯ÙŠØ« Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹ مريض مسار التجريبي Ù…Ø¹ Ø­Ù Ø¸ Ø³Ø¬Ù„ Ø§Ù„Ø­Ø³Ø§Ø³ÙŠØ© ÙˆØ§Ù„Ø­Ø§Ù„Ø§Øª',
    summaryEn: 'Updated patient profile for مريض مسار التجريبي (clinical tag history preserved)',
    ...overrides,
  };
}

async function runTests() {
  console.log('=== MASAR Care Arabic Encoding Remediation & Unit Normalization Suite ===');

  // --------------------------------------------------------------------------
  // 1. Arabic display & mojibake detection
  // --------------------------------------------------------------------------
  {
    // 1a. Correct Arabic summaries remain completely unchanged
    const cleanEntry = makeAuditEntry({
      action: 'DISPENSE_RECORDED',
      summaryAr: 'صرف ٦٠ بخة من Symbicort Turbuhaler للمريضة نور الهدى سعد الدليمي',
      summaryEn: 'Dispensed 60 puff of Symbicort Turbuhaler to نور الهدى سعد الدليمي',
    });
    assert.equal(containsCorruptedArabicMojibake(cleanEntry.summaryAr), false);
    const cleanDisplay = getAuditLogDisplaySummary(cleanEntry, 'ar');
    assert.equal(cleanDisplay.primaryText, cleanEntry.summaryAr);
    assert.equal(cleanDisplay.supportingDetail, undefined);
    assert.equal(cleanDisplay.isCorruptedArabicDetected, false);
    assert.equal(cleanDisplay.wasReconstructedFromCorruptedArabic, false);

    // 1b. Corrupted patient-registration summary is presented readably
    const regEntry = makeAuditEntry({
      action: 'PATIENT_REGISTERED',
      summaryAr: 'ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹ Ø§Ù„Ø¬Ø¯ÙŠØ¯ مريض مسار التجريبي (DEV-TEST-001)',
      summaryEn: 'Registered new patient مريض مسار التجريبي (DEV-TEST-001)',
    });
    assert.equal(containsCorruptedArabicMojibake(regEntry.summaryAr), true);
    const regDisplay = getAuditLogDisplaySummary(regEntry, 'ar');
    assert.equal(regDisplay.primaryText, 'تسجيل المراجع الجديد مريض مسار التجريبي (DEV-TEST-001)');
    assert.equal(regDisplay.supportingDetail, undefined);
    assert.equal(regDisplay.wasReconstructedFromCorruptedArabic, true);

    // 1c. Corrupted patient-update summary matches exact expected Arabic presentation
    const rawUpdateAr =
      'ØªØ­Ø¯ÙŠØ« Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹ مريض مسار التجريبي Ù…Ø¹ Ø­Ù Ø¸ Ø³Ø¬Ù„ Ø§Ù„Ø­Ø³Ø§Ø³ÙŠØ© ÙˆØ§Ù„Ø­Ø§Ù„Ø§Øª';
    const updEntry = makeAuditEntry({
      action: 'PATIENT_UPDATED',
      summaryAr: rawUpdateAr,
      summaryEn: 'Updated patient profile for مريض مسار التجريبي (clinical tag history preserved)',
    });
    const updDisplay = getAuditLogDisplaySummary(updEntry, 'ar');
    assert.equal(
      updDisplay.primaryText,
      'تحديث بيانات المراجع مريض مسار التجريبي مع حفظ سجل الحساسية والحالات'
    );
    assert.equal(updDisplay.supportingDetail, undefined);
    // Underlying record is never modified
    assert.equal(updEntry.summaryAr, rawUpdateAr);

    // 1d. Corrupted bootstrap summary is presented readably
    const bootEntry = makeAuditEntry({
      action: 'BOOTSTRAP_OWNER_PROVISIONED',
      summaryAr: 'ØªÙ…Øª ØªÙ‡ÙŠØ¦Ø© Ø§Ù„ØµÙŠØ¯Ù„ÙŠØ© Ø§Ù„Ø£ÙˆÙ„Ù‰ ÙˆØ­Ø³Ø§Ø¨ Ù…Ø§Ù„Ùƒ Ø§Ù„ØµÙŠØ¯Ù„ÙŠØ© Ù„Ù…Ø±Ø© ÙˆØ§Ø­Ø¯Ø©',
      summaryEn: 'Completed one-time initial pharmacy and pharmacy_owner bootstrap',
    });
    const bootDisplay = getAuditLogDisplaySummary(bootEntry, 'ar');
    assert.equal(
      bootDisplay.primaryText,
      'تمت تهيئة الصيدلية الأولى وحساب مالك الصيدلية لمرة واحدة'
    );

    // 1e. English summaries continue to display correctly
    const enDisplay = getAuditLogDisplaySummary(updEntry, 'en');
    assert.equal(
      enDisplay.primaryText,
      'Updated patient profile for مريض مسار التجريبي (clinical tag history preserved)'
    );
    assert.equal(enDisplay.supportingDetail, undefined);

    // 1f. Mixed Arabic/English patient names are preserved without blanket conversion damage
    const mixedEntry = makeAuditEntry({
      action: 'PATIENT_UPDATED',
      summaryAr:
        'ØªØ­Ø¯ÙŠØ« Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹ Ahmed مريض (Baghdad) Ù…Ø¹ Ø­Ù Ø¸ Ø³Ø¬Ù„ Ø§Ù„Ø­Ø³Ø§Ø³ÙŠØ© ÙˆØ§Ù„Ø­Ø§Ù„Ø§Øª',
      summaryEn:
        'Updated patient profile for Ahmed مريض (Baghdad) (clinical tag history preserved)',
    });
    const mixedDisplay = getAuditLogDisplaySummary(mixedEntry, 'ar');
    assert.equal(
      mixedDisplay.primaryText,
      'تحديث بيانات المراجع Ahmed مريض (Baghdad) مع حفظ سجل الحساسية والحالات'
    );

    // 1g. Unreconstructible known action & unsupported action codes fall back safely with English supporting detail
    const unparseableKnown = makeAuditEntry({
      action: 'DISPENSE_RECORDED',
      summaryAr: 'ØµØ±Ù  Ø¯ÙˆØ§Ø¡',
      summaryEn: 'Custom dispenser summary without standard template',
    });
    const unparseableDisplay = getAuditLogDisplaySummary(unparseableKnown, 'ar');
    assert.equal(unparseableDisplay.primaryText, 'تسجيل عملية صرف دواء');
    assert.equal(
      unparseableDisplay.supportingDetail,
      'Custom dispenser summary without standard template'
    );
    assert.equal(unparseableDisplay.wasReconstructedFromCorruptedArabic, false);

    const unsupportedEntry = makeAuditEntry({
      action: 'UNKNOWN_FUTURE_ACTION',
      summaryAr: 'Ø¨ÙŠØ§Ù†Ø§Øª ØºÙŠØ± Ù…Ø¹Ø±ÙˆÙ Ø©',
      summaryEn: 'Future audit event recorded by backend',
    });
    const unsupportedDisplay = getAuditLogDisplaySummary(unsupportedEntry, 'ar');
    assert.equal(unsupportedDisplay.primaryText, 'نشاط مسجل في سجل التدقيق');
    assert.equal(
      unsupportedDisplay.supportingDetail,
      'Future audit event recorded by backend'
    );

    // Verify additional action templates reconstruct cleanly
    assert.equal(
      reconstructArabicAuditSummary(
        'DISPENSE_RECORDED',
        'Dispensed 30 قرص of Glucophage 500mg to علي كريم'
      ),
      'صرف 30 قرص من Glucophage 500mg للمراجع علي كريم'
    );
    assert.equal(
      reconstructArabicAuditSummary(
        'MEDICATION_PLAN_ADDED',
        'Added medication plan (Concor 5mg) for سارة أحمد'
      ),
      'إضافة خطة علاجية (Concor 5mg) للمراجع سارة أحمد'
    );

    console.log('✓ 1. Arabic audit display detection, reconstruction, mixed names & safe fallback verified');
  }

  // --------------------------------------------------------------------------
  // 2. DashboardView & GovernanceView shared helper parity
  // --------------------------------------------------------------------------
  {
    const dashboardSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/views/DashboardView.tsx'),
      'utf8'
    );
    const governanceSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/views/GovernanceView.tsx'),
      'utf8'
    );
    assert.equal(
      dashboardSrc.includes('getAuditLogDisplaySummary(log, lang)'),
      true,
      'DashboardView must use shared getAuditLogDisplaySummary helper'
    );
    assert.equal(
      governanceSrc.includes('getAuditLogDisplaySummary(log, lang)'),
      true,
      'GovernanceView must use shared getAuditLogDisplaySummary helper'
    );
    assert.equal(
      dashboardSrc.includes('display.supportingDetail') &&
        governanceSrc.includes('display.supportingDetail'),
      true,
      'Both DashboardView and GovernanceView must display supportingDetail when Arabic summary cannot be reconstructed reliably'
    );
    console.log('✓ 2. DashboardView & GovernanceView share identical audit presentation behavior');
  }

  // --------------------------------------------------------------------------
  // 3. Clinical-unit normalization (Arabic + English + SQL parity)
  // --------------------------------------------------------------------------
  {
    const requiredArabicUnits: Array<[string, string, string]> = [
      ['قرص', 'tablet', 'tablet'],
      ['أقراص', 'tablet', 'tablets'],
      ['حبة', 'tablet', 'tablet'],
      ['كبسولة', 'capsule', 'capsule'],
      ['مل', 'ml', 'ml'],
      ['بخة', 'puff', 'puff'],
      ['قطرة', 'drop', 'drop'],
      ['كيس', 'sachet', 'sachet'],
      ['وحدة', 'iu', 'unit'],
      ['أمبولة', 'injection_vial', 'ampoule'],
    ];

    for (const [arUnit, expectedCategory, matchingEnUnit] of requiredArabicUnits) {
      assert.equal(
        normalizeClinicalUnitCategory(arUnit),
        expectedCategory,
        `Arabic unit "${arUnit}" must normalize to "${expectedCategory}"`
      );
      assert.equal(
        areUnitsCompatibleForRefill(matchingEnUnit, arUnit),
        true,
        `English "${matchingEnUnit}" and Arabic "${arUnit}" must be compatible`
      );
      assert.equal(
        areUnitsCompatibleForRefill(arUnit, matchingEnUnit),
        true,
        `Arabic "${arUnit}" and English "${matchingEnUnit}" must be compatible`
      );
    }

    // English units remain unchanged
    const englishUnits: Array<[string, string]> = [
      ['tablet', 'tablet'],
      ['Tablets', 'tablet'],
      ['capsule', 'capsule'],
      ['Capsules', 'capsule'],
      ['ml', 'ml'],
      ['puff', 'puff'],
      ['puffs', 'puff'],
      ['IU', 'iu'],
      ['unit', 'iu'],
      ['units', 'iu'],
      ['drop', 'drop'],
      ['drops', 'drop'],
      ['sachet', 'sachet'],
      ['sachets', 'sachet'],
      ['ampoule', 'injection_vial'],
      ['vial', 'injection_vial'],
      ['injection', 'injection_vial'],
    ];
    for (const [enUnit, expectedCategory] of englishUnits) {
      assert.equal(normalizeClinicalUnitCategory(enUnit), expectedCategory);
    }

    // Mismatched clinical units must remain incompatible
    assert.equal(areUnitsCompatibleForRefill('قرص', 'كبسولة'), false);
    assert.equal(areUnitsCompatibleForRefill('مل', 'قطرة'), false);
    assert.equal(areUnitsCompatibleForRefill('tablet', 'مل'), false);

    // SQL parity check against draft migration 0004
    const sql0004 = fs.readFileSync(
      path.join(
        process.cwd(),
        'supabase/migrations/0004_stage2b_fix_arabic_encoding_and_unit_normalization.sql'
      ),
      'utf8'
    );
    const fnStart = sql0004.indexOf(
      'CREATE OR REPLACE FUNCTION app_security.normalize_clinical_unit_category'
    );
    const fnEnd = sql0004.indexOf('REVOKE ALL ON FUNCTION app_security.normalize_clinical_unit_category');
    assert.ok(fnStart >= 0 && fnEnd > fnStart, '0004 must redefine normalize_clinical_unit_category');
    const normalizeSqlBody = sql0004.slice(fnStart, fnEnd);

    for (const [arUnit] of requiredArabicUnits) {
      assert.equal(
        normalizeSqlBody.includes(`'${arUnit}'`),
        true,
        `0004 SQL normalize_clinical_unit_category must contain clean UTF-8 literal '${arUnit}'`
      );
    }
    assert.equal(
      normalizeSqlBody.includes("'حبات'") &&
        normalizeSqlBody.includes("'كبسولات'") &&
        normalizeSqlBody.includes("'ملي'") &&
        normalizeSqlBody.includes("'بخات'") &&
        normalizeSqlBody.includes("'وحدات'") &&
        normalizeSqlBody.includes("'قطرات'") &&
        normalizeSqlBody.includes("'أكياس'") &&
        normalizeSqlBody.includes("'ظرف'") &&
        normalizeSqlBody.includes("'إبرة'") &&
        normalizeSqlBody.includes("'فيال'"),
      true,
      '0004 SQL normalize_clinical_unit_category must include all Arabic unit variants matching scheduleEngine.ts'
    );

    console.log('✓ 3. Clinical Arabic & English unit normalization & SQL 0004 parity verified');
  }

  // --------------------------------------------------------------------------
  // 4. Draft Migration 0004 (All 14 Functions) & Post-Migration SQL Verification
  // --------------------------------------------------------------------------
  {
    const sql0002 = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/0002_stage2a_rls_and_security.sql'),
      'utf8'
    );
    const sql0003 = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/0003_stage2b_atomic_crm_and_bootstrap.sql'),
      'utf8'
    );
    const sql0004 = fs.readFileSync(
      path.join(
        process.cwd(),
        'supabase/migrations/0004_stage2b_fix_arabic_encoding_and_unit_normalization.sql'
      ),
      'utf8'
    );
    const verifySql = fs.readFileSync(
      path.join(
        process.cwd(),
        'supabase/tests/stage2b_0004_post_migration_arabic_and_unit_verification.sql'
      ),
      'utf8'
    );

    // Zero mojibake (Ø/Ù byte pairs) or U+FFFD replacement characters in 0004 or verify SQL
    assert.equal(
      containsCorruptedArabicMojibake(sql0004),
      false,
      'Draft migration 0004 must contain zero mojibake or U+FFFD characters'
    );
    assert.equal(
      /[ØÙ][\u0080-\u00BF\u0152-\u2122]|\uFFFD/.test(sql0004),
      false,
      'Draft migration 0004 must contain zero Ø/Ù mojibake or replacement characters'
    );
    assert.equal(
      containsCorruptedArabicMojibake(verifySql),
      false,
      'Verification SQL must contain zero mojibake or U+FFFD characters'
    );

    const functionsFrom0003 = [
      'app_security.normalize_clinical_unit_category',
      'public.finalize_first_owner_bootstrap',
      'public.provision_pharmacy_staff_by_owner',
      'public.create_patient_with_clinical_tags',
      'public.update_patient_with_clinical_tags',
      'public.create_medication_plan_with_version',
      'public.update_medication_plan_version',
      'public.change_medication_plan_status',
      'public.record_dispensing_with_refill',
      'public.send_consultation_reply',
      'public.revoke_patient_apk_invitation',
      'app_security.write_clinical_audit_log',
    ];
    const functionsFrom0002 = [
      'public.issue_patient_apk_invitation',
      'public.redeem_patient_apk_invitation',
    ];
    const all14Functions = [...functionsFrom0003, ...functionsFrom0002];

    const declaredFns = [
      ...sql0004.matchAll(/^CREATE OR REPLACE FUNCTION\s+([a-zA-Z0-9_.]+)/gm),
    ].map((m) => m[1]);
    assert.equal(declaredFns.length, 14, '0004 must redefine all 14 affected live functions');
    assert.deepEqual(new Set(declaredFns), new Set(all14Functions));

    for (const fnName of all14Functions) {
      assert.equal(
        sql0004.includes(`CREATE OR REPLACE FUNCTION ${fnName}`),
        true,
        `0004 must include CREATE OR REPLACE FUNCTION ${fnName}`
      );
      assert.equal(
        sql0004.includes(`REVOKE ALL ON FUNCTION ${fnName}`),
        true,
        `0004 must preserve REVOKE ALL privilege hardening on ${fnName}`
      );
    }

    // Verify 0003 functions preserve SET search_path = pg_catalog, pg_temp and exact privilege split
    const searchPath0003Matches = sql0004.match(/SET search_path = pg_catalog, pg_temp\b/g) ?? [];
    assert.equal(
      searchPath0003Matches.length,
      functionsFrom0003.length,
      'All 12 functions from 0003 must preserve SET search_path = pg_catalog, pg_temp'
    );
    assert.equal(
      sql0004.includes(
        'REVOKE ALL ON FUNCTION app_security.normalize_clinical_unit_category(text) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION app_security.normalize_clinical_unit_category(text) TO service_role;'
      ),
      true
    );
    assert.equal(
      sql0004.includes(
        'REVOKE ALL ON FUNCTION app_security.write_clinical_audit_log() FROM PUBLIC, anon, authenticated;'
      ),
      true
    );

    // Verify 0002 invitation functions preserve SET search_path = pg_catalog, public, app_security, pg_temp
    const searchPath0002Matches =
      sql0004.match(/SET search_path = pg_catalog, public, app_security, pg_temp\b/g) ?? [];
    assert.equal(
      searchPath0002Matches.length,
      functionsFrom0002.length,
      'Both 0002 invitation functions must preserve SET search_path = pg_catalog, public, app_security, pg_temp'
    );
    assert.equal(
      sql0004.includes(
        'REVOKE ALL ON FUNCTION public.issue_patient_apk_invitation(uuid, text, text, integer, boolean) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.issue_patient_apk_invitation(uuid, text, text, integer, boolean) TO authenticated, service_role;'
      ),
      true,
      'issue_patient_apk_invitation must stay executable by authenticated and service_role, not anon'
    );
    assert.equal(
      sql0004.includes(
        'REVOKE ALL ON FUNCTION public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.redeem_patient_apk_invitation(text, text, text, uuid, text, text, text) TO service_role;'
      ),
      true,
      'redeem_patient_apk_invitation must stay executable by service_role only'
    );

    // Verify corrected Arabic literals for the 2 added 0002 functions are present cleanly
    assert.equal(
      sql0004.includes("THEN 'إصدار دعوة استعادة جهاز بموافقة مالك الصيدلية والتحقق المستقل'") &&
        sql0004.includes("ELSE 'إصدار دعوة تفعيل آمنة أحادية الاستخدام لتطبيق المريض'") &&
        sql0004.includes(
          "THEN 'تمت استعادة حساب المريض وربط الجهاز الجديد مع إلغاء تفويض الجلسة السابقة'"
        ) &&
        sql0004.includes(
          "ELSE 'تفعيل حساب المريض بنجاح عبر رمز الدعوة والتحقق الثنائي (OTP + PIN)'"
        ),
      true,
      '0004 must contain clean Arabic literals for issue_patient_apk_invitation and redeem_patient_apk_invitation'
    );

    // Verify NO unrelated SQL business logic changes vs 0002 & 0003:
    const extractFnBody = (sql: string, fnName: string): string => {
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${fnName}(`);
      assert.ok(start >= 0, `Missing ${fnName}`);
      const end = sql.indexOf('\n$$;', start);
      assert.ok(end > start, `Missing closing $$; for ${fnName}`);
      return sql.slice(start, end + 4);
    };
    const stripNonAscii = (s: string) => s.replace(/[^\x00-\x7F]+/g, '<UTF8>');

    for (const fnName of functionsFrom0002) {
      assert.equal(
        extractFnBody(sql0004, fnName),
        extractFnBody(sql0002, fnName),
        `0004 ${fnName} must match 0002 verbatim`
      );
    }
    for (const fnName of functionsFrom0003) {
      assert.equal(
        stripNonAscii(extractFnBody(sql0004, fnName)),
        stripNonAscii(extractFnBody(sql0003, fnName)),
        `0004 ${fnName} must not alter any non-Arabic SQL business logic vs 0003`
      );
    }

    // Must NOT recreate tables, alter tables, grant direct table writes, or rewrite audit history
    assert.equal(/\b(CREATE|DROP|ALTER)\s+TABLE\b/i.test(sql0004), false);
    assert.equal(/\bGRANT\s+(INSERT|UPDATE|DELETE|ALL)\s+ON\s+TABLE\b/i.test(sql0004), false);
    assert.equal(/\b(UPDATE|DELETE)\s+(FROM\s+)?public\.audit_logs\b/i.test(sql0004), false);

    // Post-migration verification SQL must be strictly read-only and cover all 14 functions + pre-check
    const verifySqlStatements = verifySql.replace(/--.*$/gm, '');
    assert.equal(
      /(?:^|;)\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b/im.test(verifySqlStatements),
      false,
      'Verification SQL must contain zero DML/DDL write statements'
    );
    for (const fnName of all14Functions) {
      assert.equal(
        verifySql.includes(fnName),
        true,
        `Post-migration verification SQL must check ${fnName}`
      );
    }
    assert.equal(
      verifySql.includes("convert_to('قرص', 'UTF8')"),
      true,
      'Verification SQL must include pre-installation UTF-8 round-trip check'
    );

    // SupabaseCrmRepository must preserve raw summary_ar / summary_en values
    const repoSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/services/supabaseCrmRepository.ts'),
      'utf8'
    );
    assert.equal(
      repoSrc.includes('summaryAr: String(row.summary_ar)') &&
        repoSrc.includes('summaryEn: String(row.summary_en)'),
      true,
      'SupabaseCrmRepository must preserve raw database summary_ar and summary_en values'
    );

    console.log(
      '✓ 4. Draft migration 0004 (14 functions), business-logic parity, security grants & read-only SQL checks passed'
    );
  }

  console.log('=== Arabic Encoding Remediation Suite PASSED ===');
}

runTests().catch((err) => {
  console.error('Arabic encoding remediation test suite failed:', err);
  process.exit(1);
});
