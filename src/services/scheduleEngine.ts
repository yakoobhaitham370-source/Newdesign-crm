import {
  BAGHDAD_TIMEZONE,
  formatTimeDisplay,
  LABELS,
} from '../i18n/translations';
import { getActiveBaghdadDateStr } from './clockService';
import {
  DispensingEvent,
  DoseSchedule,
  Language,
  Patient,
  PatientMedicationPlan,
  RefillProjection,
  RefillStatus,
  RegimenVersion,
  ScheduledOccurrence,
  WeekdayIndex,
} from '../types/domain';

export const BAGHDAD_UTC_OFFSET_MINUTES = 180; // Asia/Baghdad is permanently UTC+3 (no DST)
export const MAX_INTERVAL_HOURS = 720; // Up to 30 days in hours (supports 12h, 24h, 36h, 48h, 72h, etc.)
export const MAX_SAFE_SLOT_DOSE_AMOUNT = 10000;

export function isValidIsoCalendarDate(dateStr: string | undefined | null): boolean {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const trimmed = dateStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const [y, m, d] = trimmed.split('-').map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function addDaysToDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function diffDaysBetween(fromDateStr: string, toDateStr: string): number {
  const [y1, m1, d1] = fromDateStr.split('-').map(Number);
  const [y2, m2, d2] = toDateStr.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / (1000 * 60 * 60 * 24));
}

/**
 * Returns weekday index (0 = Sunday .. 6 = Saturday) for YYYY-MM-DD in Asia/Baghdad,
 * independent of the host/browser local timezone or DST rules.
 */
export function getBaghdadWeekday(dateStr: string): WeekdayIndex {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.getUTCDay() as WeekdayIndex;
}

/**
 * Converts a Baghdad local date (YYYY-MM-DD) + time (HH:mm) into UTC epoch ms.
 */
export function baghdadDateTimeToUtcMs(dateStr: string, time24: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = time24.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, 0) - BAGHDAD_UTC_OFFSET_MINUTES * 60 * 1000;
}

/**
 * Converts UTC epoch ms into Asia/Baghdad { date, time24, isoBaghdad }.
 */
export function utcMsToBaghdadParts(utcMs: number): {
  date: string;
  time24: string;
  isoBaghdad: string;
} {
  const baghdadMs = utcMs + BAGHDAD_UTC_OFFSET_MINUTES * 60 * 1000;
  const dt = new Date(baghdadMs);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  const hh = String(dt.getUTCHours()).padStart(2, '0');
  const mm = String(dt.getUTCMinutes()).padStart(2, '0');
  const date = `${y}-${m}-${d}`;
  const time24 = `${hh}:${mm}`;
  return {
    date,
    time24,
    isoBaghdad: `${date}T${time24}:00+03:00`,
  };
}

export function validateSchedule(
  schedule: DoseSchedule,
  lang: Language
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const isAr = lang === 'ar';

  if (schedule.timezone !== BAGHDAD_TIMEZONE) {
    errors.push(
      isAr
        ? 'المنطقة الزمنية المدعومة حالياً هي Asia/Baghdad.'
        : 'Schedule timezone must be Asia/Baghdad.'
    );
  }

  if (schedule.frequencyType === 'daily') {
    if (
      !Number.isFinite(schedule.timesPerDay) ||
      !Number.isInteger(schedule.timesPerDay) ||
      schedule.timesPerDay < 1 ||
      schedule.timesPerDay > 12
    ) {
      errors.push(
        isAr ? 'يجب تحديد عدد الجرعات اليومية بين ١ و ١٢.' : 'Daily frequency must be an integer between 1 and 12.'
      );
    }
    if (schedule.doseSlots.length === 0) {
      errors.push(
        isAr ? 'يجب إضافة وقت واحد على الأقل للجرعة.' : 'At least one dose time slot is required.'
      );
    } else if (
      Number.isInteger(schedule.timesPerDay) &&
      schedule.timesPerDay >= 1 &&
      schedule.doseSlots.length !== schedule.timesPerDay
    ) {
      errors.push(
        isAr
          ? `عدد أوقات الجرعات (${schedule.doseSlots.length}) لا يطابق عدد المرات اليومية المحدد (${schedule.timesPerDay}).`
          : `Dose slot count (${schedule.doseSlots.length}) must match times per day (${schedule.timesPerDay}).`
      );
    }
  }

  if (schedule.frequencyType === 'interval') {
    const val = schedule.intervalValue ?? 0;
    if (!Number.isFinite(val) || val < 1 || !Number.isInteger(val)) {
      errors.push(
        isAr
          ? 'الفاصل الزمني يجب أن يكون عدداً صحيحاً موجباً (١ أو أكثر).'
          : 'Interval value must be a positive integer (1 or greater).'
      );
    } else if (schedule.intervalUnit === 'hours' && val > MAX_INTERVAL_HOURS) {
      errors.push(
        isAr
          ? `الفاصل بالساعات لا يمكن أن يتجاوز ${MAX_INTERVAL_HOURS} ساعة (٣٠ يوماً).`
          : `Hourly interval cannot exceed ${MAX_INTERVAL_HOURS} hours (30 days).`
      );
    } else if (schedule.intervalUnit === 'days' && val > 365) {
      errors.push(
        isAr ? 'الفاصل بالأيام لا يمكن أن يتجاوز ٣٦٥ يوماً.' : 'Day interval cannot exceed 365 days.'
      );
    } else if (schedule.intervalUnit === 'weeks' && val > 52) {
      errors.push(
        isAr ? 'الفاصل بالأسابيع لا يمكن أن يتجاوز ٥٢ أسبوعاً.' : 'Week interval cannot exceed 52 weeks.'
      );
    }
    if (schedule.doseSlots.length === 0) {
      errors.push(
        isAr ? 'يرجى تحديد وقت البداية أو أوقات الجرعات.' : 'Please configure anchor start/dose time.'
      );
    } else if (schedule.intervalUnit === 'hours' && schedule.doseSlots.length > 1) {
      errors.push(
        isAr
          ? 'جدول الساعات المتكرر يتطلب وقت بداية واحداً فقط (الجرعات اللاحقة تُحسب تلقائياً).'
          : 'Hourly interval schedules require exactly one anchor start time slot.'
      );
    }
  }

  if (schedule.frequencyType === 'weekdays') {
    const rawDays = schedule.selectedWeekdays ?? [];
    const validDays = rawDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (validDays.length === 0 || validDays.length !== rawDays.length) {
      errors.push(
        isAr ? 'يرجى اختيار يوم واحد على الأقل من الأسبوع بشكل صحيح.' : 'Select at least one valid weekday (0-6).'
      );
    }
    if (schedule.doseSlots.length === 0) {
      errors.push(
        isAr ? 'يرجى تحديد وقت الجرعة في الأيام المختارة.' : 'Please set dose times for selected days.'
      );
    }
  }

  if (schedule.frequencyType === 'cyclic') {
    if (
      !Number.isFinite(schedule.cycleOnDays) ||
      !Number.isInteger(schedule.cycleOnDays) ||
      (schedule.cycleOnDays ?? 0) < 1
    ) {
      errors.push(
        isAr ? 'أيام أخذ العلاج في الدورة يجب أن تكون عدداً صحيحاً ١ على الأقل.' : 'Cycle ON days must be an integer of at least 1.'
      );
    }
    if (
      schedule.cycleOffDays === undefined ||
      !Number.isFinite(schedule.cycleOffDays) ||
      !Number.isInteger(schedule.cycleOffDays) ||
      schedule.cycleOffDays < 0
    ) {
      errors.push(
        isAr ? 'أيام التوقف في الدورة يجب أن تكون عدداً صحيحاً غير سالب.' : 'Cycle OFF days must be a non-negative integer.'
      );
    }
    if (schedule.doseSlots.length === 0) {
      errors.push(
        isAr ? 'يرجى تحديد أوقات الجرعة خلال أيام الدورة.' : 'Please configure dose times for active cycle days.'
      );
    }
  }

  if (schedule.frequencyType === 'variable') {
    if (!schedule.variablePatternNote || schedule.variablePatternNote.trim().length < 4) {
      errors.push(
        isAr
          ? 'يرجى توضيح تفاصيل الجرعة المتغيرة (مثل: صباحاً ١ قرص ومساءً نصف قرص).'
          : 'Please describe the variable dosing pattern clearly.'
      );
    }
  }

  if (schedule.frequencyType === 'prn') {
    if (!schedule.prnIndication || schedule.prnIndication.trim().length < 2) {
      errors.push(
        isAr ? 'يرجى كتابة داعي الاستعمال عند اللزوم.' : 'Please specify the PRN indication.'
      );
    }
    if (
      schedule.prnMaxPerDay !== undefined &&
      (!Number.isFinite(schedule.prnMaxPerDay) ||
        !Number.isInteger(schedule.prnMaxPerDay) ||
        schedule.prnMaxPerDay < 1 ||
        schedule.prnMaxPerDay > 24)
    ) {
      errors.push(
        isAr
          ? 'الحد الأقصى للجرعات عند اللزوم يومياً يجب أن يكون عدداً صحيحاً بين ١ و ٢٤.'
          : 'PRN max doses per day must be an integer between 1 and 24.'
      );
    }
    if (schedule.doseSlots.length > 0) {
      errors.push(
        isAr
          ? 'علاج عند اللزوم (PRN) لا يجب أن يحتوي على مواعيد جرعات مجدولة.'
          : 'PRN schedules must not include fixed scheduled dose time slots.'
      );
    }
  }

  const seenTimes = new Set<string>();
  for (const slot of schedule.doseSlots) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time24)) {
      errors.push(isAr ? 'صيغة الوقت غير صحيحة.' : 'Invalid time format (expected HH:mm).');
      break;
    }
    if (seenTimes.has(slot.time24)) {
      errors.push(
        isAr
          ? `وقت الجرعة مكرر (${slot.time24}). يجب أن يكون لكل جرعة توقيت مختلف.`
          : `Duplicate dose time slot (${slot.time24}). Each dose slot must have a distinct time.`
      );
      break;
    }
    seenTimes.add(slot.time24);
    if (!Number.isFinite(slot.doseAmount) || slot.doseAmount <= 0 || slot.doseAmount > MAX_SAFE_SLOT_DOSE_AMOUNT) {
      errors.push(
        isAr
          ? `كمية الجرعة في كل توقيت يجب أن تكون أكبر من صفر وأقل من أو تساوي ${MAX_SAFE_SLOT_DOSE_AMOUNT}.`
          : `Dose amount in each slot must be greater than zero and at most ${MAX_SAFE_SLOT_DOSE_AMOUNT}.`
      );
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Checks whether a calendar date (YYYY-MM-DD in Asia/Baghdad) falls inside a pause period
 * or on/after a current paused/discontinued/archived cutoff.
 */
export function isDatePausedForPlan(plan: PatientMedicationPlan, dateStr: string): boolean {
  if (plan.pausePeriods && plan.pausePeriods.length > 0) {
    for (const p of plan.pausePeriods) {
      if (p.resumedAt) {
        if (dateStr >= p.pausedFrom && dateStr < p.resumedAt) {
          return true;
        }
      } else if (dateStr >= p.pausedFrom) {
        return true;
      }
    }
  }

  if (plan.status !== 'active') {
    if (!plan.statusChangedAt) return true;
    if (dateStr >= plan.statusChangedAt) return true;
  }

  return false;
}

interface EffectiveRegimenSlice {
  versionNumber: number;
  anchorDate: string;
  sliceStart: string;
  sliceEnd: string;
  doseAmount: number;
  doseUnit: string;
  schedule: DoseSchedule;
}

/**
 * Resolves chronological regimen version slices across [windowStart, windowEnd] so historical
 * dose/schedule adjustments with effectiveFrom/effectiveTo dates are accurately honored.
 */
function buildEffectiveRegimenSlices(
  plan: PatientMedicationPlan,
  windowStart: string,
  windowEnd: string,
  allowPreStartAnchor = false
): EffectiveRegimenSlice[] {
  const history =
    plan.regimenHistory && plan.regimenHistory.length > 0
      ? [...plan.regimenHistory].sort((a, b) => a.versionNumber - b.versionNumber)
      : [
          {
            versionNumber: plan.currentVersionNumber,
            effectiveFrom: plan.startDate,
            doseAmount: plan.doseAmount,
            doseUnit: plan.doseUnit,
            foodRelation: plan.foodRelation,
            verifiedInstructions: plan.verifiedInstructions,
            schedule: plan.schedule,
            changedByStaffName: '',
            changeReason: '',
            createdAt: plan.createdAt,
          } satisfies RegimenVersion,
        ];

  const slices: EffectiveRegimenSlice[] = [];

  for (let i = 0; i < history.length; i++) {
    const v = history[i];
    const isLatest = i === history.length - 1 || v.versionNumber === plan.currentVersionNumber;
    const rawStart =
      i === 0 && allowPreStartAnchor && windowStart < v.effectiveFrom
        ? windowStart
        : v.effectiveFrom;
    const rawEnd =
      !isLatest && v.effectiveTo ? addDaysToDate(v.effectiveTo, -1) : '9999-12-31';

    // If a version was created and superseded on the same day (effectiveFrom === effectiveTo), skip it
    if (rawStart > rawEnd) continue;

    const sliceStart = rawStart > windowStart ? rawStart : windowStart;
    const sliceEnd = rawEnd < windowEnd ? rawEnd : windowEnd;
    if (sliceStart > sliceEnd) continue;

    slices.push({
      versionNumber: v.versionNumber,
      anchorDate: i === 0 && allowPreStartAnchor && windowStart < plan.startDate ? windowStart : v.effectiveFrom || plan.startDate,
      sliceStart,
      sliceEnd,
      doseAmount: isLatest ? plan.doseAmount : v.doseAmount,
      doseUnit: isLatest ? plan.doseUnit : v.doseUnit,
      schedule: isLatest ? plan.schedule : v.schedule,
    });
  }

  return slices;
}

function generateOccurrencesForSlice(
  plan: PatientMedicationPlan,
  slice: EffectiveRegimenSlice,
  ignorePauseStatus = false
): ScheduledOccurrence[] {
  const sched = slice.schedule;
  if (sched.frequencyType === 'prn') return [];

  const occurrences: ScheduledOccurrence[] = [];

  // Hourly intervals (Every 8h, 12h, 24h, 36h, 48h, etc.) — preserves exact recurrence anchor across days & midnight
  if (sched.frequencyType === 'interval' && sched.intervalUnit === 'hours') {
    const stepHours = Math.max(1, sched.intervalValue ?? 8);
    const stepMs = stepHours * 60 * 60 * 1000;
    const anchorTime = sched.doseSlots[0]?.time24 ?? '08:00';
    const anchorDose = sched.doseSlots[0]?.doseAmount ?? slice.doseAmount;
    const anchorLabel = sched.doseSlots[0]?.label;

    let currentMs = baghdadDateTimeToUtcMs(slice.anchorDate, anchorTime);
    const windowStartMs = baghdadDateTimeToUtcMs(slice.sliceStart, '00:00');
    const windowEndMs = baghdadDateTimeToUtcMs(slice.sliceEnd, '23:59');

    if (currentMs < windowStartMs) {
      const stepsToSkip = Math.floor((windowStartMs - currentMs) / stepMs);
      currentMs += stepsToSkip * stepMs;
      while (currentMs < windowStartMs) {
        currentMs += stepMs;
      }
    }

    let guard = 0;
    while (currentMs <= windowEndMs && guard < 10000) {
      guard++;
      const parts = utcMsToBaghdadParts(currentMs);
      if (parts.date >= slice.sliceStart && parts.date <= slice.sliceEnd) {
        if (ignorePauseStatus || !isDatePausedForPlan(plan, parts.date)) {
          occurrences.push({
            date: parts.date,
            time24: parts.time24,
            isoBaghdad: parts.isoBaghdad,
            doseAmount: anchorDose,
            doseUnit: slice.doseUnit,
            slotLabel: anchorLabel,
            medicationPlanId: plan.id,
            regimenVersionNumber: slice.versionNumber,
          });
        }
      }
      currentMs += stepMs;
    }
    return occurrences;
  }

  // Day-based schedules (daily, variable with slots, weekdays, cyclic, interval in days/weeks)
  if (!sched.doseSlots || sched.doseSlots.length === 0) return [];
  const sortedSlots = [...sched.doseSlots].sort((a, b) => a.time24.localeCompare(b.time24));
  const totalDays = diffDaysBetween(slice.sliceStart, slice.sliceEnd);

  for (let offset = 0; offset <= totalDays && offset < 4000; offset++) {
    const currentDate = addDaysToDate(slice.sliceStart, offset);
    if (!ignorePauseStatus && isDatePausedForPlan(plan, currentDate)) continue;

    const daysSinceAnchor = diffDaysBetween(slice.anchorDate, currentDate);
    if (daysSinceAnchor < 0) continue;

    let matchesDay = false;
    if (sched.frequencyType === 'daily' || sched.frequencyType === 'variable') {
      matchesDay = true;
    } else if (sched.frequencyType === 'weekdays') {
      const wd = getBaghdadWeekday(currentDate);
      matchesDay = (sched.selectedWeekdays ?? []).includes(wd);
    } else if (sched.frequencyType === 'cyclic') {
      const onDays = Math.max(1, sched.cycleOnDays ?? 21);
      const offDays = Math.max(0, sched.cycleOffDays ?? 7);
      const cycleLen = onDays + offDays;
      const pos = ((daysSinceAnchor % cycleLen) + cycleLen) % cycleLen;
      matchesDay = pos < onDays;
    } else if (sched.frequencyType === 'interval') {
      const val = Math.max(1, sched.intervalValue ?? 1);
      const stepDays = sched.intervalUnit === 'weeks' ? val * 7 : val;
      matchesDay = daysSinceAnchor % stepDays === 0;
    }

    if (!matchesDay) continue;

    for (const slot of sortedSlots) {
      occurrences.push({
        date: currentDate,
        time24: slot.time24,
        isoBaghdad: `${currentDate}T${slot.time24}:00+03:00`,
        doseAmount: slot.doseAmount,
        doseUnit: slice.doseUnit,
        slotLabel: slot.label,
        medicationPlanId: plan.id,
        regimenVersionNumber: slice.versionNumber,
      });
    }
  }

  return occurrences;
}

/**
 * Generates concrete scheduled dose occurrences between [fromDateStr, toDateStr] inclusive
 * in Asia/Baghdad timezone. Preserves exact recurrence anchors across calendar days and
 * midnight transitions (Every 8h, 12h, 24h, 36h, 48h, Every N days/weeks, weekdays,
 * 21d ON / 7d OFF cycles), honors historical regimen versions, start/end boundaries,
 * and pause/discontinue windows.
 */
export function generateScheduledOccurrences(
  plan: PatientMedicationPlan,
  fromDateStr: string,
  toDateStr: string
): ScheduledOccurrence[] {
  if (fromDateStr > toDateStr) return [];
  if (plan.schedule.frequencyType === 'prn') return [];

  const effectiveStart = plan.startDate > fromDateStr ? plan.startDate : fromDateStr;
  let effectiveEnd = toDateStr;

  if (!plan.isOngoing && plan.endDate && plan.endDate < effectiveEnd) {
    effectiveEnd = plan.endDate;
  }

  if (plan.status !== 'active') {
    if (!plan.statusChangedAt) return [];
    const dayBeforePause = addDaysToDate(plan.statusChangedAt, -1);
    if (dayBeforePause < effectiveEnd) {
      effectiveEnd = dayBeforePause;
    }
  }

  if (effectiveStart > effectiveEnd) return [];

  const slices = buildEffectiveRegimenSlices(plan, effectiveStart, effectiveEnd, false);
  const allOccurrences: ScheduledOccurrence[] = [];
  for (const slice of slices) {
    allOccurrences.push(...generateOccurrencesForSlice(plan, slice, false));
  }
  return allOccurrences;
}

/**
 * Normalizes unit strings across Arabic and English to detect unit mismatches
 * between prescribed doseUnit and dispensed quantityUnit.
 */
export function normalizeClinicalUnitCategory(unit: string): string {
  const u = unit.trim().toLowerCase();
  if (['tablet', 'tablets', 'tab', 'tabs', 'قرص', 'أقراص', 'حبة', 'حبات'].includes(u)) return 'tablet';
  if (['capsule', 'capsules', 'cap', 'caps', 'كبسولة', 'كبسولات'].includes(u)) return 'capsule';
  if (['ml', 'ملي', 'مل'].includes(u)) return 'ml';
  if (['puff', 'puffs', 'بخة', 'بخات'].includes(u)) return 'puff';
  if (['iu', 'iu / inj', 'unit', 'units', 'وحدة', 'وحدات', 'وحدة / حقنة'].includes(u)) return 'iu';
  if (['drop', 'drops', 'قطرة', 'قطرات'].includes(u)) return 'drop';
  if (['sachet', 'sachets', 'كيس', 'أكياس', 'ظرف'].includes(u)) return 'sachet';
  if (['ampoule', 'vial', 'injection', 'إبرة', 'أمبولة', 'فيال'].includes(u)) return 'injection_vial';
  if (['mg', 'milligram', 'milligrams', 'ملغ', 'مجم'].includes(u)) return 'mg';
  if (['mcg', 'ug', 'µg', 'microgram', 'micrograms', 'ميكروغرام', 'مكغ'].includes(u)) return 'mcg';
  if (['g', 'gm', 'gram', 'grams', 'غرام', 'غ'].includes(u)) return 'g';
  if (['bottle', 'bottles', 'زجاجة', 'عبوة سائل'].includes(u)) return 'bottle';
  if (['pack', 'packs', 'box', 'boxes', 'عبوة', 'علبة'].includes(u)) return 'pack';
  if (['application', 'applications', 'تطبيق موضعي', 'دهنة'].includes(u)) return 'application';
  return u;
}

export function areUnitsCompatibleForRefill(doseUnit: string, dispensedUnit: string): boolean {
  if (!doseUnit?.trim() || !dispensedUnit?.trim()) return false;
  return normalizeClinicalUnitCategory(doseUnit) === normalizeClinicalUnitCategory(dispensedUnit);
}

/**
 * Internal helper for occurrence-driven supply simulation. Walks scheduled occurrences
 * across historical regimen versions, finite endDate boundaries, and pause/resume windows.
 */
function generateSupplyOccurrences(
  plan: PatientMedicationPlan,
  fromDateStr: string,
  toDateStr: string
): ScheduledOccurrence[] {
  let effectiveEnd = toDateStr;
  if (!plan.isOngoing && plan.endDate && plan.endDate < effectiveEnd) {
    effectiveEnd = plan.endDate;
  }
  if (fromDateStr > effectiveEnd) return [];
  const slices = buildEffectiveRegimenSlices(plan, fromDateStr, effectiveEnd, true);
  const allOccurrences: ScheduledOccurrence[] = [];
  for (const slice of slices) {
    allOccurrences.push(...generateOccurrencesForSlice(plan, slice, false));
  }
  return allOccurrences;
}

/**
 * Simulates supply depletion occurrence-by-occurrence starting on `fillDate` with `initialStock` units.
 * Returns the exact calendar date (`estimatedSupplyEndDate`) on which the next scheduled dose
 * cannot be fulfilled because remaining stock < required dose amount, avoiding misleading
 * average-daily-rate estimates on cyclic (21d ON / 7d OFF), multi-day interval (36h, 48h),
 * weekday, paused/resumed, or multi-version regimens.
 *
 * Audit Finding H7 Fix:
 * When `initialStock` covers ALL scheduled occurrences in a finite treatment course (`!plan.isOngoing && plan.endDate`)
 * or exceeds the 10-year (3,650-day) horizon, returns `estimatedSupplyEndDate: null` and `noDepletionWithinPlan: true`
 * instead of inventing a fictional next-day refill date.
 */
export function simulateSupplyDepletionFromOccurrences(
  plan: PatientMedicationPlan,
  fillDate: string,
  initialStock: number
): {
  estimatedSupplyDays: number | null;
  estimatedSupplyEndDate: string | null;
  dosesCoveredCount: number;
  noDepletionWithinPlan?: boolean;
} {
  if (!Number.isFinite(initialStock) || initialStock <= 0 || !isValidIsoCalendarDate(fillDate)) {
    return {
      estimatedSupplyDays: null,
      estimatedSupplyEndDate: null,
      dosesCoveredCount: 0,
      noDepletionWithinPlan: false,
    };
  }

  const { dailyRate } = computeDailyConsumption(plan);
  if (!dailyRate || dailyRate <= 0) {
    return {
      estimatedSupplyDays: null,
      estimatedSupplyEndDate: null,
      dosesCoveredCount: 0,
      noDepletionWithinPlan: false,
    };
  }

  // Estimate a generous horizon in calendar days to guarantee finding the first unfulfilled occurrence
  const estimatedDaysUpper = Math.min(3650, Math.max(120, Math.ceil((initialStock / dailyRate) * 2.5) + 90));
  const horizonEnd = addDaysToDate(fillDate, estimatedDaysUpper);
  const occurrences = generateSupplyOccurrences(plan, fillDate, horizonEnd);

  if (occurrences.length === 0) {
    const isCompletedFiniteCourse =
      !plan.isOngoing && Boolean(plan.endDate) && Boolean(plan.endDate && fillDate > plan.endDate);
    return {
      estimatedSupplyDays: null,
      estimatedSupplyEndDate: null,
      dosesCoveredCount: 0,
      noDepletionWithinPlan: isCompletedFiniteCourse,
    };
  }

  let pool = initialStock;
  let dosesCoveredCount = 0;

  for (const occ of occurrences) {
    if (pool + 1e-9 >= occ.doseAmount) {
      pool = Number((pool - occ.doseAmount).toFixed(4));
      dosesCoveredCount++;
    } else {
      // `occ` is the first scheduled dose occurrence where available supply is insufficient
      const supplyDays = Math.max(0, diffDaysBetween(fillDate, occ.date));
      return {
        estimatedSupplyDays: supplyDays,
        estimatedSupplyEndDate: occ.date,
        dosesCoveredCount,
        noDepletionWithinPlan: false,
      };
    }
  }

  // All occurrences within the finite course or 3650-day horizon were covered without running short on a subsequent dose
  return {
    estimatedSupplyDays: null,
    estimatedSupplyEndDate: null,
    dosesCoveredCount,
    noDepletionWithinPlan: true,
  };
}

export function computeDailyConsumptionFromSchedule(
  schedule: DoseSchedule,
  fallbackDoseAmount: number,
  doseUnit: string,
  planStatus: PatientMedicationPlan['status']
): {
  dailyRate: number | null;
  assumptionAr: string;
  assumptionEn: string;
} {
  if (planStatus !== 'active') {
    return {
      dailyRate: null,
      assumptionAr: 'الخطة الدوائية ليست نشطة حالياً (متوقفة أو منتهية).',
      assumptionEn: 'Medication plan is currently paused, discontinued, or archived.',
    };
  }

  const slotSum = schedule.doseSlots.reduce(
    (acc, s) => acc + (Number.isFinite(s.doseAmount) && s.doseAmount > 0 ? s.doseAmount : 0),
    0
  );

  switch (schedule.frequencyType) {
    case 'daily': {
      const rate = slotSum > 0 ? slotSum : fallbackDoseAmount * schedule.timesPerDay;
      if (!Number.isFinite(rate) || rate <= 0) {
        return {
          dailyRate: null,
          assumptionAr: 'بيانات الجرعة اليومية غير مكتملة لحساب المعدل.',
          assumptionEn: 'Insufficient daily dose data to compute consumption rate.',
        };
      }
      return {
        dailyRate: Number(rate.toFixed(3)),
        assumptionAr: `تقدير مبني على التزام كامل بجدول الجرعات (${Number(rate.toFixed(3))} ${doseUnit}/يوم).`,
        assumptionEn: `Estimated from scheduled occurrences assuming full adherence (${Number(rate.toFixed(3))} ${doseUnit}/day).`,
      };
    }
    case 'interval': {
      const val = Math.max(1, schedule.intervalValue ?? 1);
      if (schedule.intervalUnit === 'hours') {
        const dosesPerDay = 24 / val;
        const perDose = schedule.doseSlots[0]?.doseAmount ?? fallbackDoseAmount;
        const rate = dosesPerDay * perDose;
        return {
          dailyRate: Number(rate.toFixed(3)),
          assumptionAr: `تقدير مبني على مواعيد الجرعات الفعلية كل ${val} ساعة (${perDose} ${doseUnit}/جرعة، متوسط ${rate.toFixed(2)} ${doseUnit}/يوم).`,
          assumptionEn: `Occurrence-based estimate every ${val}h (${perDose} ${doseUnit}/dose, avg ${rate.toFixed(2)} ${doseUnit}/day).`,
        };
      }
      if (schedule.intervalUnit === 'weeks') {
        const rate = (slotSum || fallbackDoseAmount) / (val * 7);
        return {
          dailyRate: Number(rate.toFixed(4)),
          assumptionAr: `تقدير مبني على مواعيد الجرعات كل ${val} أسبوع (متوسط ${rate.toFixed(2)} ${doseUnit}/يوم).`,
          assumptionEn: `Occurrence-based estimate every ${val} week(s) (avg ${rate.toFixed(2)} ${doseUnit}/day).`,
        };
      }
      const rate = (slotSum || fallbackDoseAmount) / val;
      return {
        dailyRate: Number(rate.toFixed(3)),
        assumptionAr: `تقدير مبني على مواعيد الجرعات كل ${val} يوم (متوسط ${rate.toFixed(2)} ${doseUnit}/يوم).`,
        assumptionEn: `Occurrence-based estimate every ${val} day(s) (avg ${rate.toFixed(2)} ${doseUnit}/day).`,
      };
    }
    case 'weekdays': {
      const daysCount = Math.max(1, schedule.selectedWeekdays?.length ?? 0);
      if (!schedule.selectedWeekdays || schedule.selectedWeekdays.length === 0) {
        return {
          dailyRate: null,
          assumptionAr: 'لم تُحدد أيام الأسبوع لحساب الاستهلاك.',
          assumptionEn: 'No weekdays selected to estimate consumption.',
        };
      }
      const rate = ((slotSum || fallbackDoseAmount) * daysCount) / 7;
      return {
        dailyRate: Number(rate.toFixed(3)),
        assumptionAr: `تقدير مبني على أيام الأخذ المحددة (${daysCount} أيام/أسبوع، متوسط ${rate.toFixed(2)} ${doseUnit}/يوم).`,
        assumptionEn: `Occurrence-based estimate for ${daysCount} selected weekday(s)/week (avg ${rate.toFixed(2)} ${doseUnit}/day).`,
      };
    }
    case 'cyclic': {
      const onDays = Math.max(1, schedule.cycleOnDays ?? 21);
      const offDays = Math.max(0, schedule.cycleOffDays ?? 7);
      const cycleTotal = onDays + offDays;
      const dailyDuringOn = slotSum || fallbackDoseAmount;
      const rate = (dailyDuringOn * onDays) / cycleTotal;
      return {
        dailyRate: Number(rate.toFixed(3)),
        assumptionAr: `محاكاة مواعيد الدورة الفعلية (${onDays} يوم أخذ بمعدل ${dailyDuringOn} ${doseUnit}/يوم ثم ${offDays} يوم توقف بدون استهلاك).`,
        assumptionEn: `Simulated over actual cycle occurrences (${onDays}d ON at ${dailyDuringOn} ${doseUnit}/day, ${offDays}d OFF with 0 consumption).`,
      };
    }
    case 'variable': {
      if (slotSum > 0) {
        return {
          dailyRate: Number(slotSum.toFixed(3)),
          assumptionAr: `جدول متغير الجرعة محدد المواعيد (${Number(slotSum.toFixed(3))} ${doseUnit}/يوم عبر الجرعات المجدولة) — قد يتغير حسب التدريج.`,
          assumptionEn: `Variable regimen with explicit slot quantities (${Number(slotSum.toFixed(3))} ${doseUnit}/day across scheduled slots); subject to titration.`,
        };
      }
      return {
        dailyRate: null,
        assumptionAr: 'تعذر التقدير: جدول متغير بدون كميات يومية ثابتة — يتطلب مراجعة الصيدلي.',
        assumptionEn: 'Unable to estimate: variable schedule without fixed daily slot quantities — pharmacist review required.',
      };
    }
    case 'prn':
    default:
      return {
        dailyRate: null,
        assumptionAr: 'علاج عند اللزوم (PRN): لا يُحسب له تاريخ نفاد تلقائي لعدم ثبات الاستخدام المستقبلي.',
        assumptionEn: 'As-needed (PRN): supply depletion date not auto-calculated due to unknown future consumption.',
      };
  }
}

export function computeDailyConsumption(plan: PatientMedicationPlan): {
  dailyRate: number | null;
  assumptionAr: string;
  assumptionEn: string;
} {
  return computeDailyConsumptionFromSchedule(
    plan.schedule,
    plan.doseAmount,
    plan.doseUnit,
    plan.status
  );
}

export function calculateDispensingForecast(
  plan: PatientMedicationPlan,
  dispensedQuantity: number,
  dispensingDate: string,
  lang: Language,
  dispensedUnit?: string
): {
  estimatedDailyConsumption: number | null;
  estimatedSupplyDays: number | null;
  estimatedSupplyEndDate: string | null;
  assumptionsText: string;
} {
  const effectiveDispensedUnit = dispensedUnit ?? plan.doseUnit;
  if (!areUnitsCompatibleForRefill(plan.doseUnit, effectiveDispensedUnit)) {
    return {
      estimatedDailyConsumption: null,
      estimatedSupplyDays: null,
      estimatedSupplyEndDate: null,
      assumptionsText:
        lang === 'ar'
          ? `تعذر التقدير: وحدة الصرف (${effectiveDispensedUnit || '—'}) غير متوافقة مع وحدة الجرعة الموصوفة (${plan.doseUnit || '—'}).`
          : `Unable to estimate: dispensed unit (${effectiveDispensedUnit || '—'}) is incompatible with prescribed dose unit (${plan.doseUnit || '—'}).`,
    };
  }

  const { dailyRate, assumptionAr, assumptionEn } = computeDailyConsumption(plan);
  if (
    !dailyRate ||
    dailyRate <= 0 ||
    !Number.isFinite(dispensedQuantity) ||
    dispensedQuantity <= 0 ||
    !isValidIsoCalendarDate(dispensingDate)
  ) {
    return {
      estimatedDailyConsumption: dailyRate,
      estimatedSupplyDays: null,
      estimatedSupplyEndDate: null,
      assumptionsText:
        !Number.isFinite(dispensedQuantity) || dispensedQuantity <= 0
          ? lang === 'ar'
            ? 'تعذر التقدير: الكمية المصروفة غير صالحة.'
            : 'Unable to estimate: invalid dispensed quantity.'
          : !isValidIsoCalendarDate(dispensingDate)
            ? lang === 'ar'
              ? 'تعذر التقدير: تاريخ الصرف غير صالح.'
              : 'Unable to estimate: invalid dispensing date.'
            : lang === 'ar'
              ? assumptionAr
              : assumptionEn,
    };
  }

  const sim = simulateSupplyDepletionFromOccurrences(plan, dispensingDate, dispensedQuantity);
  if (sim.noDepletionWithinPlan) {
    const isFinite = !plan.isOngoing && Boolean(plan.endDate);
    return {
      estimatedDailyConsumption: dailyRate,
      estimatedSupplyDays: null,
      estimatedSupplyEndDate: null,
      assumptionsText: isFinite
        ? lang === 'ar'
          ? `الكمية المصروفة تغطي كامل فترة العلاج المحددة حتى ${plan.endDate} دون الحاجة لإعادة صرف.`
          : `Dispensed quantity covers the complete finite course through ${plan.endDate}; no refill needed.`
        : lang === 'ar'
          ? 'فائض مخزون طويل الأمد يتجاوز أفق التقدير دون تاريخ نفاد وشيك.'
          : 'Long-term surplus stock exceeds forecast horizon with no imminent depletion date.',
    };
  }

  return {
    estimatedDailyConsumption: dailyRate,
    estimatedSupplyDays: sim.estimatedSupplyDays,
    estimatedSupplyEndDate: sim.estimatedSupplyEndDate,
    assumptionsText: lang === 'ar' ? assumptionAr : assumptionEn,
  };
}

/**
 * Computes refill projection across ALL chronological dispensing events for a plan using
 * real scheduled occurrences. Accounts for:
 * - 21-day ON / 7-day OFF cyclic treatment (zero consumption during OFF days)
 * - Early refills and carryover stock
 * - Multiple partial dispensing events
 * - Dose changes with historical effective dates (regimenHistory versions)
 * - Supply depletion gaps between dispensing events (clamped to 0 before subsequent fill)
 * - Variable daily dose quantities (multi-slot explicit quantities vs non-deterministic -> unable_to_estimate)
 * - PRN medications with unknown future consumption (-> paused_or_prn, null depletion date)
 * - Medication pause/resume windows (pausePeriods -> zero consumption while paused)
 * - Finite treatment courses (!plan.isOngoing && plan.endDate) and surplus stock (never invents a refill date)
 * - Incompatible doseUnit vs dispensed quantityUnit (-> unable_to_estimate)
 */
export function computeRefillProjection(
  plan: PatientMedicationPlan,
  patient: Patient,
  dispensingEvents: DispensingEvent[],
  lang: Language,
  refDateStr: string = getActiveBaghdadDateStr()
): RefillProjection {
  const validEventsAsc = dispensingEvents
    .filter(
      (d) =>
        d.medicationPlanId === plan.id &&
        Number.isFinite(d.dispensedQuantity) &&
        d.dispensedQuantity > 0 &&
        isValidIsoCalendarDate(d.dispensingDate)
    )
    .sort(
      (a, b) =>
        a.dispensingDate.localeCompare(b.dispensingDate) ||
        a.createdAt.localeCompare(b.createdAt)
    );

  const latest = validEventsAsc[validEventsAsc.length - 1];
  const { dailyRate, assumptionAr, assumptionEn } = computeDailyConsumption(plan);
  const medLabel = `${plan.brandName} (${plan.genericName} ${plan.strength})`;

  if (!isValidIsoCalendarDate(refDateStr) || !isValidIsoCalendarDate(plan.startDate)) {
    return {
      medicationPlanId: plan.id,
      patientId: patient.id,
      patientName: patient.fullName,
      patientCode: patient.patientCode,
      medicationLabel: medLabel,
      medicationStatus: plan.status,
      lastDispensedDate: latest?.dispensingDate,
      lastDispensedQuantity: latest?.dispensedQuantity,
      quantityUnit: latest?.quantityUnit ?? plan.doseUnit,
      estimatedDailyConsumption: dailyRate,
      estimatedRemainingUnits: null,
      estimatedDaysRemaining: null,
      estimatedSupplyEndDate: null,
      refillStatus: 'unable_to_estimate',
      uncertaintyNote:
        lang === 'ar'
          ? 'تعذر التقدير: تاريخ الخطة أو التاريخ المرجعي غير صالح.'
          : 'Unable to estimate: invalid plan start date or reference date.',
    };
  }

  // Paused, discontinued, archived, or PRN plans do not project an active depletion countdown
  if (plan.status !== 'active' || plan.schedule.frequencyType === 'prn') {
    return {
      medicationPlanId: plan.id,
      patientId: patient.id,
      patientName: patient.fullName,
      patientCode: patient.patientCode,
      medicationLabel: medLabel,
      medicationStatus: plan.status,
      lastDispensedDate: latest?.dispensingDate,
      lastDispensedQuantity: latest?.dispensedQuantity,
      totalDispensedAnalyzed: validEventsAsc.reduce((s, e) => s + e.dispensedQuantity, 0) || undefined,
      quantityUnit: latest?.quantityUnit ?? plan.doseUnit,
      estimatedDailyConsumption: dailyRate,
      estimatedRemainingUnits: null,
      estimatedDaysRemaining: null,
      estimatedSupplyEndDate: null,
      refillStatus: 'paused_or_prn',
      uncertaintyNote: lang === 'ar' ? assumptionAr : assumptionEn,
    };
  }

  // Active plan whose schedule lacks deterministic daily slot quantities (e.g., variable titration without fixed slots)
  if (!dailyRate || dailyRate <= 0) {
    return {
      medicationPlanId: plan.id,
      patientId: patient.id,
      patientName: patient.fullName,
      patientCode: patient.patientCode,
      medicationLabel: medLabel,
      medicationStatus: plan.status,
      lastDispensedDate: latest?.dispensingDate,
      lastDispensedQuantity: latest?.dispensedQuantity,
      totalDispensedAnalyzed: validEventsAsc.reduce((s, e) => s + e.dispensedQuantity, 0) || undefined,
      quantityUnit: latest?.quantityUnit ?? plan.doseUnit,
      estimatedDailyConsumption: null,
      estimatedRemainingUnits: null,
      estimatedDaysRemaining: null,
      estimatedSupplyEndDate: null,
      refillStatus: 'unable_to_estimate',
      uncertaintyNote: lang === 'ar' ? assumptionAr : assumptionEn,
    };
  }

  // Active plan without any dispensing event -> strictly "Unable to estimate" (never invent a date or mark overdue)
  if (!latest) {
    return {
      medicationPlanId: plan.id,
      patientId: patient.id,
      patientName: patient.fullName,
      patientCode: patient.patientCode,
      medicationLabel: medLabel,
      medicationStatus: plan.status,
      quantityUnit: plan.doseUnit,
      estimatedDailyConsumption: dailyRate,
      estimatedRemainingUnits: null,
      estimatedDaysRemaining: null,
      estimatedSupplyEndDate: null,
      refillStatus: 'unable_to_estimate',
      uncertaintyNote:
        lang === 'ar'
          ? 'تعذر التقدير: لم يُسجل أي صرف لهذه الخطة الدوائية بعد.'
          : 'Unable to estimate: no dispensing event recorded for this medication plan yet.',
    };
  }

  // Guard against incompatible dispensing unit vs prescribed doseUnit
  const incompatibleEvent = validEventsAsc.find(
    (evt) => !areUnitsCompatibleForRefill(plan.doseUnit, evt.quantityUnit)
  );
  if (incompatibleEvent) {
    return {
      medicationPlanId: plan.id,
      patientId: patient.id,
      patientName: patient.fullName,
      patientCode: patient.patientCode,
      medicationLabel: medLabel,
      medicationStatus: plan.status,
      lastDispensedDate: latest.dispensingDate,
      lastDispensedQuantity: latest.dispensedQuantity,
      totalDispensedAnalyzed: validEventsAsc.reduce((s, e) => s + e.dispensedQuantity, 0),
      quantityUnit: latest.quantityUnit,
      estimatedDailyConsumption: dailyRate,
      estimatedRemainingUnits: null,
      estimatedDaysRemaining: null,
      estimatedSupplyEndDate: null,
      refillStatus: 'unable_to_estimate',
      uncertaintyNote:
        lang === 'ar'
          ? `تعذر التقدير: وحدة الصرف (${incompatibleEvent.quantityUnit}) غير متوافقة مع وحدة الجرعة الموصوفة (${plan.doseUnit}).`
          : `Unable to estimate: dispensed unit (${incompatibleEvent.quantityUnit}) is incompatible with prescribed dose unit (${plan.doseUnit}).`,
    };
  }

  // Walk chronological dispensing ledger up to refDateStr using real scheduled occurrences
  let runningUnits = 0;
  let totalDispensedAnalyzed = 0;
  let lastStockAfterFill = 0;
  let lastFillDate = validEventsAsc[0].dispensingDate;
  let hadCarryover = false;
  let hadDepletionGapBetweenFills = false;
  let analyzedFillCount = 0;

  for (let i = 0; i < validEventsAsc.length; i++) {
    const evt = validEventsAsc[i];
    if (evt.dispensingDate > refDateStr) {
      break;
    }
    if (i > 0 && evt.dispensingDate > lastFillDate) {
      const segEnd = addDaysToDate(evt.dispensingDate, -1);
      const segOccurrences = generateSupplyOccurrences(plan, lastFillDate, segEnd);
      const consumedInGap = segOccurrences.reduce((acc, o) => acc + o.doseAmount, 0);

      if (runningUnits < consumedInGap - 1e-9) {
        hadDepletionGapBetweenFills = true;
        runningUnits = 0;
      } else {
        runningUnits = Number((runningUnits - consumedInGap).toFixed(4));
        if (runningUnits > 0) {
          hadCarryover = true;
        }
      }
    }
    runningUnits = Number((runningUnits + evt.dispensedQuantity).toFixed(4));
    totalDispensedAnalyzed = Number((totalDispensedAnalyzed + evt.dispensedQuantity).toFixed(4));
    lastStockAfterFill = runningUnits;
    lastFillDate = evt.dispensingDate;
    analyzedFillCount++;
  }

  // If all dispensing events are dated in the future relative to refDateStr
  if (analyzedFillCount === 0 || totalDispensedAnalyzed === 0) {
    return {
      medicationPlanId: plan.id,
      patientId: patient.id,
      patientName: patient.fullName,
      patientCode: patient.patientCode,
      medicationLabel: medLabel,
      medicationStatus: plan.status,
      lastDispensedDate: latest.dispensingDate,
      lastDispensedQuantity: latest.dispensedQuantity,
      quantityUnit: latest.quantityUnit,
      estimatedDailyConsumption: dailyRate,
      estimatedRemainingUnits: null,
      estimatedDaysRemaining: null,
      estimatedSupplyEndDate: null,
      refillStatus: 'unable_to_estimate',
      uncertaintyNote:
        lang === 'ar'
          ? 'تعذر التقدير: تاريخ الصرف المسجل بعد التاريخ المرجعي الحالي.'
          : 'Unable to estimate: recorded dispensing date is after the reference date.',
    };
  }

  // Compute units consumed between lastFillDate and refDateStr via real scheduled occurrences
  let consumedSinceLast = 0;
  if (refDateStr > lastFillDate) {
    const elapsedOcc = generateSupplyOccurrences(
      plan,
      lastFillDate,
      addDaysToDate(refDateStr, -1)
    );
    consumedSinceLast = elapsedOcc.reduce((acc, o) => acc + o.doseAmount, 0);
  }

  const remainingUnits = Math.max(0, Number((lastStockAfterFill - consumedSinceLast).toFixed(1)));
  const depletionSim = simulateSupplyDepletionFromOccurrences(
    plan,
    lastFillDate,
    lastStockAfterFill
  );

  // Audit Finding H7: Finite treatment course fully covered by dispensed stock OR long-term surplus stock
  if (depletionSim.noDepletionWithinPlan) {
    const isFinite = !plan.isOngoing && Boolean(plan.endDate);
    return {
      medicationPlanId: plan.id,
      patientId: patient.id,
      patientName: patient.fullName,
      patientCode: patient.patientCode,
      medicationLabel: medLabel,
      medicationStatus: plan.status,
      lastDispensedDate: lastFillDate,
      lastDispensedQuantity: latest.dispensedQuantity,
      totalDispensedAnalyzed,
      quantityUnit: latest.quantityUnit,
      estimatedDailyConsumption: dailyRate,
      estimatedRemainingUnits: remainingUnits,
      estimatedDaysRemaining: null,
      estimatedSupplyEndDate: null,
      refillStatus: 'on_track',
      uncertaintyNote: isFinite
        ? lang === 'ar'
          ? `الكمية المصروفة تغطي كامل فترة العلاج المحددة حتى ${plan.endDate} — لا يتطلب إعادة صرف.`
          : `Dispensed supply covers the entire finite treatment course through ${plan.endDate} — no refill required.`
        : lang === 'ar'
          ? 'فائض مخزون طويل الأمد يغطي كامل أفق التقدير دون تاريخ نفاد وشيك.'
          : 'Long-term surplus stock covers the entire forecast horizon with no imminent depletion date.',
    };
  }

  if (!depletionSim.estimatedSupplyEndDate) {
    return {
      medicationPlanId: plan.id,
      patientId: patient.id,
      patientName: patient.fullName,
      patientCode: patient.patientCode,
      medicationLabel: medLabel,
      medicationStatus: plan.status,
      lastDispensedDate: lastFillDate,
      lastDispensedQuantity: latest.dispensedQuantity,
      totalDispensedAnalyzed,
      quantityUnit: latest.quantityUnit,
      estimatedDailyConsumption: dailyRate,
      estimatedRemainingUnits: null,
      estimatedDaysRemaining: null,
      estimatedSupplyEndDate: null,
      refillStatus: 'unable_to_estimate',
      uncertaintyNote:
        lang === 'ar'
          ? 'تعذر التقدير: لا توجد مواعيد جرعات مجدولة لحساب تاريخ نفاد الكمية.'
          : 'Unable to estimate: no scheduled occurrences available to project depletion date.',
    };
  }

  const endDate = depletionSim.estimatedSupplyEndDate;
  const daysRemaining = diffDaysBetween(refDateStr, endDate);

  let refillStatus: RefillStatus = 'on_track';
  if (daysRemaining <= 0) refillStatus = 'overdue';
  else if (daysRemaining <= 7) refillStatus = 'due_soon';
  else if (daysRemaining <= 14) refillStatus = 'upcoming';

  const notesParts: string[] = [lang === 'ar' ? assumptionAr : assumptionEn];
  if (analyzedFillCount > 1) {
    notesParts.push(
      lang === 'ar'
        ? `شمل الحساب التراكمي ${analyzedFillCount} عمليات صرف`
        : `Cumulative calculation across ${analyzedFillCount} dispensing events`
    );
  }
  if (hadCarryover) {
    notesParts.push(
      lang === 'ar'
        ? 'تضمن ترحيل رصيد متبقٍ من صرف مبكر سابق'
        : 'Includes carryover stock from early refill'
    );
  }
  if (hadDepletionGapBetweenFills) {
    notesParts.push(
      lang === 'ar'
        ? 'تمت مراعاة فترة نفاد الرصيد بين عمليات الصرف دون خصم سلبي'
        : 'Supply depletion gap between fills clamped at zero prior to refill'
    );
  }
  if (validEventsAsc.slice(0, analyzedFillCount).some((e) => e.isPartialFill)) {
    notesParts.push(lang === 'ar' ? 'يتضمن صرفاً جزئياً' : 'Includes partial fill');
  }
  if (plan.currentVersionNumber > 1) {
    notesParts.push(
      lang === 'ar'
        ? `محدث وفق سجل النسخ العلاجية (النسخة الحالية v${plan.currentVersionNumber})`
        : `Adjusted across regimen version history (current v${plan.currentVersionNumber})`
    );
  }
  if (plan.pausePeriods && plan.pausePeriods.length > 0) {
    notesParts.push(
      lang === 'ar'
        ? `تم استثناء فترات التوقف المؤقت (${plan.pausePeriods.length}) من الاستهلاك`
        : `Excluded ${plan.pausePeriods.length} pause period(s) from consumption`
    );
  }

  return {
    medicationPlanId: plan.id,
    patientId: patient.id,
    patientName: patient.fullName,
    patientCode: patient.patientCode,
    medicationLabel: medLabel,
    medicationStatus: plan.status,
    lastDispensedDate: lastFillDate,
    lastDispensedQuantity: latest.dispensedQuantity,
    totalDispensedAnalyzed,
    quantityUnit: latest.quantityUnit,
    estimatedDailyConsumption: dailyRate,
    estimatedRemainingUnits: remainingUnits,
    estimatedDaysRemaining: daysRemaining,
    estimatedSupplyEndDate: endDate,
    refillStatus,
    uncertaintyNote: notesParts.join(' · '),
  };
}

export function formatScheduleSummary(
  schedule: DoseSchedule,
  doseUnit: string,
  lang: Language,
  use12Hour = true
): string {
  const isAr = lang === 'ar';
  const timesList = schedule.doseSlots
    .map((s) => `${formatTimeDisplay(s.time24, use12Hour, lang)} (${s.doseAmount} ${doseUnit})`)
    .join(isAr ? '، ' : ', ');

  switch (schedule.frequencyType) {
    case 'daily':
      return isAr
        ? `يومياً (${schedule.timesPerDay} ${schedule.timesPerDay === 1 ? 'مرة' : 'مرات'}) — ${timesList}`
        : `Daily (${schedule.timesPerDay}x/day) — ${timesList}`;
    case 'interval': {
      const unitLabel =
        schedule.intervalUnit === 'hours'
          ? isAr
            ? 'ساعة'
            : 'hour(s)'
          : schedule.intervalUnit === 'weeks'
            ? isAr
              ? 'أسبوع'
              : 'week(s)'
            : isAr
              ? 'يوم'
              : 'day(s)';
      return isAr
        ? `كل ${schedule.intervalValue} ${unitLabel}${timesList ? ` — ${timesList}` : ''}`
        : `Every ${schedule.intervalValue} ${unitLabel}${timesList ? ` — ${timesList}` : ''}`;
    }
    case 'weekdays': {
      const days = (schedule.selectedWeekdays ?? [])
        .map((idx) => LABELS[lang].weekdaysShort[idx])
        .join(isAr ? '، ' : ', ');
      return isAr
        ? `أيام محددة (${days}) — ${timesList}`
        : `Selected days (${days}) — ${timesList}`;
    }
    case 'cyclic':
      return isAr
        ? `دورة علاجية: ${schedule.cycleOnDays} يوم علاج / ${schedule.cycleOffDays} يوم توقف — ${timesList}`
        : `Cyclic: ${schedule.cycleOnDays}d ON / ${schedule.cycleOffDays}d OFF — ${timesList}`;
    case 'variable':
      return isAr
        ? `جدول متغير: ${schedule.variablePatternNote ?? ''}${timesList ? ` (${timesList})` : ''}`
        : `Variable: ${schedule.variablePatternNote ?? ''}${timesList ? ` (${timesList})` : ''}`;
    case 'prn':
      return isAr
        ? `عند اللزوم (${schedule.prnIndication ?? ''})${schedule.prnMaxPerDay ? ` — حد أقصى ${schedule.prnMaxPerDay} يومياً` : ''}`
        : `As needed (${schedule.prnIndication ?? ''})${schedule.prnMaxPerDay ? ` — max ${schedule.prnMaxPerDay}/day` : ''}`;
    default:
      return timesList;
  }
}
