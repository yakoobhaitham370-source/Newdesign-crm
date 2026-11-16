import type { AuditLogEntry, Language } from '../types/domain';

export interface AuditLogDisplayResult {
  primaryText: string;
  supportingDetail?: string;
  isCorruptedArabicDetected: boolean;
  wasReconstructedFromCorruptedArabic: boolean;
}

/**
 * Detects double-encoded UTF-8 Arabic mojibake (UTF-8 bytes D8..DB + 80..BF
 * misread as Latin-1 / Windows-1252 and re-encoded as UTF-8) or Unicode
 * replacement characters (U+FFFD).
 *
 * Intentionally avoids running a blanket Unicode conversion over arbitrary text
 * so valid mixed Arabic/English text and patient names are never damaged.
 */
const ARABIC_MOJIBAKE_PATTERN =
  /(?:[\u00D8-\u00DB][\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122])|\uFFFD/;

export function containsCorruptedArabicMojibake(text: string | null | undefined): boolean {
  if (!text) return false;
  return ARABIC_MOJIBAKE_PATTERN.test(text);
}

const KNOWN_AUDIT_ACTION_LABELS_AR: Record<string, string> = {
  BOOTSTRAP_OWNER_PROVISIONED: 'تهيئة الصيدلية الأولى وحساب مالك الصيدلية',
  STAFF_PROVISIONED: 'إضافة صيدلي مخوّل جديد',
  PATIENT_REGISTERED: 'تسجيل مراجع جديد',
  PATIENT_UPDATED: 'تحديث بيانات المراجع',
  PATIENT_ARCHIVED: 'أرشفة ملف المراجع',
  PATIENT_RESTORED: 'إعادة تفعيل ملف المراجع',
  MEDICATION_PLAN_ADDED: 'إضافة خطة علاجية',
  REGIMEN_VERSION_CREATED: 'تعديل خطة علاجية وحفظ نسخة الجرعة',
  MEDICATION_STATUS_CHANGED: 'تغيير حالة الخطة العلاجية',
  DISPENSE_RECORDED: 'تسجيل عملية صرف دواء',
  LAB_RESULT_RECORDED: 'تسجيل نتيجة تحليل مخبري',
  FOLLOWUP_CREATED: 'إنشاء مهمة متابعة سريرية',
  FOLLOWUP_STATUS_UPDATED: 'تحديث حالة مهمة المتابعة',
  FOLLOWUP_CONTACT_LOGGED: 'توثيق تواصل متابعة مع المراجع',
  DOSE_EVENT_UPDATED: 'تحديث حالة الجرعة المجدولة',
  CONSULTATION_REPLIED: 'إرسال رد صيدلاني معتمد على استشارة المراجع',
  CONSULTATION_STATUS_UPDATED: 'تحديث حالة الاستشارة',
  INVITATION_ISSUED: 'إصدار دعوة تفعيل لتطبيق المريض',
  INVITATION_RECOVERY_ISSUED: 'إصدار دعوة استعادة جهاز للمراجع',
  INVITATION_REDEEMED: 'تفعيل حساب المريض عبر التطبيق',
  INVITATION_RECOVERY_REDEEMED: 'استعادة حساب المريض وربط الجهاز الجديد',
  INVITATION_REVOKED: 'إلغاء دعوة تطبيق المريض',
  INVITATION_REPLACED_ACTIVATED: 'استبدال وتفعيل دعوة تطبيق المريض',
};

const FALLBACK_UNKNOWN_ACTION_AR = 'نشاط مسجل في سجل التدقيق';

/**
 * Reconstructs a clean Arabic summary ONLY when the authoritative action code
 * and structured English summary match known database templates reliably.
 * Returns null if details cannot be verified without guessing or fabricating.
 */
export function reconstructArabicAuditSummary(
  action: string,
  summaryEn: string | null | undefined
): string | null {
  const en = (summaryEn ?? '').trim();
  if (!en || containsCorruptedArabicMojibake(en)) {
    return null;
  }

  switch (action) {
    case 'BOOTSTRAP_OWNER_PROVISIONED': {
      if (en === 'Completed one-time initial pharmacy and pharmacy_owner bootstrap') {
        return 'تمت تهيئة الصيدلية الأولى وحساب مالك الصيدلية لمرة واحدة';
      }
      return null;
    }

    case 'STAFF_PROVISIONED': {
      const m = /^Provisioned new authorized_pharmacist:\s*(.+)$/.exec(en);
      if (m && m[1].trim()) {
        return `إضافة صيدلي مخوّل جديد: ${m[1].trim()} (authorized_pharmacist)`;
      }
      return null;
    }

    case 'PATIENT_REGISTERED': {
      const m = /^Registered new patient\s+(.+)\s+\(([^()]+)\)$/.exec(en);
      if (m && m[1].trim() && m[2].trim()) {
        return `تسجيل المراجع الجديد ${m[1].trim()} (${m[2].trim()})`;
      }
      return null;
    }

    case 'PATIENT_UPDATED': {
      const withHistory = /^Updated patient profile for\s+(.+)\s+\(clinical tag history preserved\)$/.exec(en);
      if (withHistory && withHistory[1].trim()) {
        return `تحديث بيانات المراجع ${withHistory[1].trim()} مع حفظ سجل الحساسية والحالات`;
      }
      const basic = /^Updated patient profile for\s+(.+)$/.exec(en);
      if (basic && basic[1].trim()) {
        return `تحديث بيانات المراجع ${basic[1].trim()}`;
      }
      return null;
    }

    case 'PATIENT_ARCHIVED': {
      const withHistory = /^Archived patient\s+(.+)\s+\(clinical history preserved\)$/.exec(en);
      if (withHistory && withHistory[1].trim()) {
        return `أرشفة ملف المراجع ${withHistory[1].trim()} مع حفظ السجل`;
      }
      return null;
    }

    case 'PATIENT_RESTORED': {
      const m = /^Restored patient profile for\s+(.+)$/.exec(en);
      if (m && m[1].trim()) {
        return `إعادة تفعيل ملف المراجع ${m[1].trim()}`;
      }
      return null;
    }

    case 'MEDICATION_PLAN_ADDED': {
      const m = /^Added medication plan \((.+)\) for\s+(.+)$/.exec(en);
      if (m && m[1].trim() && m[2].trim()) {
        return `إضافة خطة علاجية (${m[1].trim()}) للمراجع ${m[2].trim()}`;
      }
      return null;
    }

    case 'REGIMEN_VERSION_CREATED': {
      const m = /^Updated\s+(.+)\s+plan \(preserved version #(\d+)\)$/.exec(en);
      if (m && m[1].trim() && m[2].trim()) {
        return `تعديل خطة ${m[1].trim()} وحفظ النسخة رقم ${m[2].trim()}`;
      }
      return null;
    }

    case 'MEDICATION_STATUS_CHANGED': {
      const m = /^Changed status of\s+(.+)\s+to\s+([^\s]+)$/.exec(en);
      if (m && m[1].trim() && m[2].trim()) {
        return `تغيير حالة ${m[1].trim()} إلى (${m[2].trim()})`;
      }
      return null;
    }

    case 'DISPENSE_RECORDED': {
      const m = /^Dispensed\s+([0-9]+(?:\.[0-9]+)?)\s+(.+?)\s+of\s+(.+?)\s+to\s+(.+)$/.exec(en);
      if (m && m[1].trim() && m[2].trim() && m[3].trim() && m[4].trim()) {
        return `صرف ${m[1].trim()} ${m[2].trim()} من ${m[3].trim()} للمراجع ${m[4].trim()}`;
      }
      return null;
    }

    case 'CONSULTATION_REPLIED': {
      if (en === 'Pharmacist-approved consultation reply sent') {
        return 'إرسال رد صيدلاني معتمد على استشارة المراجع';
      }
      return null;
    }

    case 'INVITATION_REVOKED': {
      const m = /^Revoked APK invitation for\s+(.+)$/.exec(en);
      if (m && m[1].trim()) {
        return `إلغاء دعوة تطبيق المريض للمراجع ${m[1].trim()}`;
      }
      return null;
    }

    case 'LAB_RESULT_RECORDED': {
      const m = /^Recorded lab result\s+(.+?):\s*(.+)$/.exec(en);
      if (m && m[1].trim() && m[2].trim()) {
        return `تسجيل نتيجة تحليل ${m[1].trim()}: ${m[2].trim()}`;
      }
      return null;
    }

    case 'FOLLOWUP_CREATED': {
      const m = /^Created follow-up task due\s+(\d{4}-\d{2}-\d{2})$/.exec(en);
      if (m && m[1].trim()) {
        return `إنشاء مهمة متابعة بتاريخ ${m[1].trim()}`;
      }
      return null;
    }

    case 'FOLLOWUP_STATUS_UPDATED': {
      const m = /^Updated follow-up task status to\s+([^\s]+)$/.exec(en);
      if (m && m[1].trim()) {
        return `تحديث حالة المتابعة إلى (${m[1].trim()})`;
      }
      return null;
    }

    case 'FOLLOWUP_CONTACT_LOGGED': {
      const m = /^Recorded follow-up contact via\s+([^\s]+)$/.exec(en);
      if (m && m[1].trim()) {
        return `توثيق تواصل متابعة عبر (${m[1].trim()})`;
      }
      return null;
    }

    case 'DOSE_EVENT_UPDATED': {
      const m = /^Updated scheduled dose status to\s+([^\s]+)$/.exec(en);
      if (m && m[1].trim()) {
        return `تحديث حالة الجرعة إلى (${m[1].trim()})`;
      }
      return null;
    }

    case 'CONSULTATION_STATUS_UPDATED': {
      const m = /^Updated consultation status to\s+([^\s]+)$/.exec(en);
      if (m && m[1].trim()) {
        return `تحديث حالة الاستشارة إلى (${m[1].trim()})`;
      }
      return null;
    }

    default:
      return null;
  }
}

export function getAuditActionFallbackLabelAr(action: string): string {
  return KNOWN_AUDIT_ACTION_LABELS_AR[action] ?? FALLBACK_UNKNOWN_ACTION_AR;
}

/**
 * Shared presentation helper for DashboardView and GovernanceView.
 * Never mutates the underlying AuditLogEntry record or raw database fields.
 */
export function getAuditLogDisplaySummary(
  log: Pick<AuditLogEntry, 'action' | 'summaryAr' | 'summaryEn'>,
  lang: Language
): AuditLogDisplayResult {
  const rawAr = log.summaryAr ?? '';
  const rawEn = log.summaryEn ?? '';
  const corruptedAr = containsCorruptedArabicMojibake(rawAr);

  if (lang === 'en') {
    return {
      primaryText: rawEn.trim() ? rawEn : log.action,
      isCorruptedArabicDetected: corruptedAr,
      wasReconstructedFromCorruptedArabic: false,
    };
  }

  // Arabic mode: preserve clean, uncorrupted Arabic summaries completely unchanged.
  if (rawAr.trim().length > 0 && !corruptedAr) {
    return {
      primaryText: rawAr,
      isCorruptedArabicDetected: false,
      wasReconstructedFromCorruptedArabic: false,
    };
  }

  // Corrupted or empty Arabic summary: attempt reliable template reconstruction.
  const reconstructed = reconstructArabicAuditSummary(log.action, rawEn);
  if (reconstructed) {
    return {
      primaryText: reconstructed,
      isCorruptedArabicDetected: corruptedAr,
      wasReconstructedFromCorruptedArabic: corruptedAr,
    };
  }

  // Cannot be reliably reconstructed without guessing: show clear Arabic action label
  // with the original English summary as supporting detail.
  return {
    primaryText: getAuditActionFallbackLabelAr(log.action),
    supportingDetail: rawEn.trim() || undefined,
    isCorruptedArabicDetected: corruptedAr,
    wasReconstructedFromCorruptedArabic: false,
  };
}
