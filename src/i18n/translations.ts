import {
  ConsultationStatus,
  ContactOutcome,
  ContactPreference,
  DosageForm,
  DoseConfirmationStatus,
  FoodRelation,
  FollowUpStatus,
  FollowUpType,
  InvitationStatus,
  Language,
  MedicationPlanStatus,
  RefillStatus,
  ScheduleFrequencyType,
  StaffRole,
} from '../types/domain';

import { getActiveBaghdadDateStr } from '../services/clockService';

export const BAGHDAD_TIMEZONE = 'Asia/Baghdad' as const;

/**
 * Returns today's YYYY-MM-DD formatted strictly in Asia/Baghdad (UTC+3).
 */
export function getBaghdadTodayDateStr(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BAGHDAD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value ?? '2026';
  const m = parts.find((p) => p.type === 'month')?.value ?? '11';
  const d = parts.find((p) => p.type === 'day')?.value ?? '12';
  return `${y}-${m}-${d}`;
}

/**
 * Normalizes Iraqi mobile numbers (07XXXXXXXXX, +9647XXXXXXXXX, 009647XXXXXXXXX)
 * into canonical 11-digit local format `07XXXXXXXXX`.
 */
export function normalizeIraqiPhone(raw: string): string {
  const digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+9647') && digits.length === 14) {
    return `0${digits.slice(4)}`;
  }
  if (digits.startsWith('009647') && digits.length === 15) {
    return `0${digits.slice(5)}`;
  }
  if (digits.startsWith('9647') && digits.length === 13) {
    return `0${digits.slice(3)}`;
  }
  return digits;
}

/**
 * Validates Iraqi mobile operator prefixes (073-079, 11 digits total).
 */
export function isValidIraqiPhone(raw: string): boolean {
  const normalized = normalizeIraqiPhone(raw);
  return /^07[3-9]\d{8}$/.test(normalized);
}

export function formatDate(dateStr: string | undefined, lang: Language): string {
  if (!dateStr) return '—';
  // Anchor YYYY-MM-DD at 12:00 UTC so Baghdad (UTC+3 = 15:00) never shifts calendar day
  const parsed = new Date(dateStr.includes('T') ? dateStr : `${dateStr}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dateStr;
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-IQ' : 'en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    numberingSystem: 'latn',
    timeZone: BAGHDAD_TIMEZONE,
  }).format(parsed);
}

export function formatDateTime(isoStr: string | undefined, lang: Language): string {
  if (!isoStr) return '—';
  const parsed = new Date(isoStr);
  if (Number.isNaN(parsed.getTime())) return isoStr;
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-IQ' : 'en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    numberingSystem: 'latn',
    timeZone: BAGHDAD_TIMEZONE,
  }).format(parsed);
}

export function formatTimeDisplay(time24: string, use12Hour: boolean, lang: Language): string {
  const [hhStr, mmStr] = time24.split(':');
  const hh = Number(hhStr);
  const mm = Number(mmStr);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return time24;
  if (!use12Hour) {
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  const period = hh >= 12 ? (lang === 'ar' ? 'م' : 'PM') : lang === 'ar' ? 'ص' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${period}`;
}

export function calculateAge(
  dobStr: string,
  refDateStr: string = getActiveBaghdadDateStr()
): number {
  const [dy, dm, dd] = dobStr.split('-').map(Number);
  const [ry, rm, rd] = refDateStr.split('-').map(Number);
  if (!dy || !dm || !dd || !ry || !rm || !rd) return 0;
  let age = ry - dy;
  if (rm < dm || (rm === dm && rd < dd)) {
    age--;
  }
  return Math.max(0, age);
}

export const LABELS = {
  ar: {
    brandName: 'MASAR Care',
    brandTagline: 'منصة رعاية المرضى المزمنين',
    prototypeBadge: 'المرحلة ١ — بيانات تجريبية افتراضية',
    nav: {
      dashboard: 'لوحة التحكم',
      patients: 'المرضى',
      dispensing: 'صرف العلاج',
      refills: 'إعادة الصرف',
      invitations: 'دعوات تطبيق المريض',
      followups: 'المتابعات السريرية',
      consultations: 'الاستشارات',
      analytics: 'التحليلات',
      governance: 'البنية والصلاحيات',
    },
    common: {
      save: 'حفظ',
      cancel: 'إلغاء',
      close: 'إغلاق',
      edit: 'تعديل',
      search: 'بحث...',
      filter: 'تصفية',
      all: 'الكل',
      active: 'نشط',
      archived: 'مؤرشف',
      actions: 'إجراءات',
      back: 'رجوع',
      next: 'التالي',
      previous: 'السابق',
      add: 'إضافة',
      viewProfile: 'فتح الملف',
      status: 'الحالة',
      notes: 'ملاحظات',
      date: 'التاريخ',
      estimateLabel: 'تقدير محسوب',
      noData: 'لا توجد بيانات مطابقة',
      baghdadTz: 'توقيت بغداد (UTC+3)',
      years: 'سنة',
      days: 'يوم',
      resetDemo: 'إعادة ضبط البيانات التجريبية',
    },
    dosageForms: {
      tablet: 'أقراص / حبوب',
      capsule: 'كبسولات',
      syrup: 'شراب',
      injection: 'حقنة',
      inhaler: 'بخاخ استنشاق',
      drops: 'قطرات',
      cream: 'مرهم / كريم',
      sachet: 'أكياس فوارة',
    } as Record<DosageForm, string>,
    foodRelations: {
      before_food: 'قبل الطعام',
      with_food: 'مع الطعام',
      after_food: 'بعد الطعام',
      any_time: 'في أي وقت (لا يهم)',
    } as Record<FoodRelation, string>,
    frequencyTypes: {
      daily: 'يومياً',
      interval: 'فاصلة زمنية محددة',
      weekdays: 'أيام محددة بالأسبوع',
      cyclic: 'دورة علاجية مخصصة',
      variable: 'جدول متغير الجرعة',
      prn: 'عند اللزوم (PRN)',
    } as Record<ScheduleFrequencyType, string>,
    medStatus: {
      active: 'نشط',
      paused: 'متوقف مؤقتاً',
      discontinued: 'موقوف نهائياً',
      archived: 'مؤرشف',
    } as Record<MedicationPlanStatus, string>,
    refillStatus: {
      overdue: 'متأخر عن موعد إعادة الصرف',
      due_soon: 'يستحق إعادة الصرف قريباً',
      upcoming: 'مجدول خلال أسبوعين',
      on_track: 'ضمن الرصيد المتوقع',
      unable_to_estimate: 'تعذر التقدير',
      paused_or_prn: 'متوقف أو عند اللزوم (تعذر التقدير)',
    } as Record<RefillStatus, string>,
    invitationStatus: {
      not_invited: 'لم تُصدر دعوة بعد',
      pending: 'بانتظار تفعيل المريض',
      activated: 'مُفعّل ومربوط',
      expired: 'منتهي الصلاحية',
      revoked: 'ملغي من الصيدلي',
    } as Record<InvitationStatus, string>,
    doseConfirmStatus: {
      pending_unconfirmed: 'بانتظار التأكيد (غير مؤكد)',
      taken: 'مؤكد من المريض (تم الأخذ)',
      skipped_by_patient: 'تجاوزها المريض',
      delayed: 'تأخر عن الموعد',
    } as Record<DoseConfirmationStatus, string>,
    followUpTypes: {
      refill: 'متابعة إعادة الصرف',
      adherence: 'متابعة الالتزام',
      clinical: 'متابعة سريرية',
      lab_review: 'مراجعة تحاليل',
    } as Record<FollowUpType, string>,
    followUpStatus: {
      pending: 'قيد الانتظار',
      completed: 'مكتمل',
      overdue: 'متأخر',
    } as Record<FollowUpStatus, string>,
    contactOutcomes: {
      answered: 'تم الرد والتأكيد',
      no_answer: 'لم يرد',
      refill_confirmed: 'تم تأكيد طلب إعادة الصرف',
      appointment_scheduled: 'تم تحديد موعد زيارة',
      message_sent: 'أُرسلت رسالة تذكير',
    } as Record<ContactOutcome, string>,
    consultationStatus: {
      open: 'استشارة مفتوحة',
      follow_up: 'قيد المتابعة',
      resolved: 'مغلقة / محلولة',
    } as Record<ConsultationStatus, string>,
    contactPref: {
      whatsapp: 'واتساب',
      phone_call: 'اتصال هاتفي',
      apk_notification: 'إشعارات التطبيق',
    } as Record<ContactPreference, string>,
    roles: {
      platform_owner: 'مالك المنصة',
      pharmacy_owner: 'مالك الصيدلية',
      authorized_pharmacist: 'صيدلي مخوّل',
      patient_apk_user: 'مستخدم تطبيق المريض',
    } as Record<StaffRole, string>,
    weekdaysShort: ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'],
  },
  en: {
    brandName: 'MASAR Care',
    brandTagline: 'Chronic Care Pharmacy CRM',
    prototypeBadge: 'Stage 1 — Fictional Demo Data',
    nav: {
      dashboard: 'Dashboard',
      patients: 'Patients',
      dispensing: 'Dispensing',
      refills: 'Refill Monitor',
      invitations: 'APK Invitations',
      followups: 'Follow-ups',
      consultations: 'Consultations',
      analytics: 'Analytics',
      governance: 'Architecture & Roles',
    },
    common: {
      save: 'Save',
      cancel: 'Cancel',
      close: 'Close',
      edit: 'Edit',
      search: 'Search...',
      filter: 'Filter',
      all: 'All',
      active: 'Active',
      archived: 'Archived',
      actions: 'Actions',
      back: 'Back',
      next: 'Next',
      previous: 'Previous',
      add: 'Add',
      viewProfile: 'Open Profile',
      status: 'Status',
      notes: 'Notes',
      date: 'Date',
      estimateLabel: 'Calculated Estimate',
      noData: 'No matching records found',
      baghdadTz: 'Baghdad Time (UTC+3)',
      years: 'yrs',
      days: 'days',
      resetDemo: 'Reset Demo Data',
    },
    dosageForms: {
      tablet: 'Tablets',
      capsule: 'Capsules',
      syrup: 'Syrup',
      injection: 'Injection',
      inhaler: 'Inhaler',
      drops: 'Drops',
      cream: 'Cream / Ointment',
      sachet: 'Sachets',
    } as Record<DosageForm, string>,
    foodRelations: {
      before_food: 'Before food',
      with_food: 'With food',
      after_food: 'After food',
      any_time: 'Any time',
    } as Record<FoodRelation, string>,
    frequencyTypes: {
      daily: 'Daily',
      interval: 'Fixed interval',
      weekdays: 'Selected weekdays',
      cyclic: 'Treatment cycle',
      variable: 'Variable schedule',
      prn: 'As needed (PRN)',
    } as Record<ScheduleFrequencyType, string>,
    medStatus: {
      active: 'Active',
      paused: 'Paused',
      discontinued: 'Discontinued',
      archived: 'Archived',
    } as Record<MedicationPlanStatus, string>,
    refillStatus: {
      overdue: 'Overdue for refill',
      due_soon: 'Refill due soon',
      upcoming: 'Due within 14 days',
      on_track: 'Supply on track',
      unable_to_estimate: 'Unable to estimate',
      paused_or_prn: 'Paused / PRN (Unable to estimate)',
    } as Record<RefillStatus, string>,
    invitationStatus: {
      not_invited: 'Not invited',
      pending: 'Pending activation',
      activated: 'Activated',
      expired: 'Expired',
      revoked: 'Revoked',
    } as Record<InvitationStatus, string>,
    doseConfirmStatus: {
      pending_unconfirmed: 'Unconfirmed (Pending)',
      taken: 'Patient confirmed taken',
      skipped_by_patient: 'Skipped by patient',
      delayed: 'Delayed',
    } as Record<DoseConfirmationStatus, string>,
    followUpTypes: {
      refill: 'Refill follow-up',
      adherence: 'Adherence check',
      clinical: 'Clinical review',
      lab_review: 'Lab review',
    } as Record<FollowUpType, string>,
    followUpStatus: {
      pending: 'Pending',
      completed: 'Completed',
      overdue: 'Overdue',
    } as Record<FollowUpStatus, string>,
    contactOutcomes: {
      answered: 'Answered & confirmed',
      no_answer: 'No answer',
      refill_confirmed: 'Refill confirmed',
      appointment_scheduled: 'Visit scheduled',
      message_sent: 'Reminder sent',
    } as Record<ContactOutcome, string>,
    consultationStatus: {
      open: 'Open',
      follow_up: 'Follow-up',
      resolved: 'Resolved',
    } as Record<ConsultationStatus, string>,
    contactPref: {
      whatsapp: 'WhatsApp',
      phone_call: 'Phone Call',
      apk_notification: 'App Notification',
    } as Record<ContactPreference, string>,
    roles: {
      platform_owner: 'Platform Owner',
      pharmacy_owner: 'Pharmacy Owner',
      authorized_pharmacist: 'Authorized Pharmacist',
      patient_apk_user: 'Patient APK User',
    } as Record<StaffRole, string>,
    weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  },
};
