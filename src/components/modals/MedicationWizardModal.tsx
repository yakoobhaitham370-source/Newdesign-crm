import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useCrm } from '../../context/CrmContext';
import { MEDICATION_CATALOG } from '../../data/seedData';
import { formatDate, formatTimeDisplay, LABELS } from '../../i18n/translations';
import {
  ALLOWED_ROUTES_BY_DOSAGE_FORM,
  assessMedicationAllergyRisk,
  isValidIsoCalendarDate,
  MAX_REASONABLE_DOSE_AMOUNT,
  validateAllergyOverrideAuthorization,
  validateDosageFormRouteCompatibility,
  validateDosageFormUnitCompatibility,
  validateMedicationEditAllowed,
  validateMedicationPlanInput,
} from '../../services/clinicalSafety';
import { findDuplicateActiveMedication } from '../../services/crmRepository';
import {
  addDaysToDate,
  diffDaysBetween,
  formatScheduleSummary,
  validateSchedule,
} from '../../services/scheduleEngine';
import { AllergySafetyBanner } from '../common/AllergySafetyBanner';
import {
  AdministrationRoute,
  AllergyOverrideAuthorization,
  DosageForm,
  DoseSchedule,
  DoseTimeSlot,
  FoodRelation,
  IntervalUnit,
  MedicationCatalogItem,
  Patient,
  PatientMedicationPlan,
  ScheduleFrequencyType,
  WeekdayIndex,
} from '../../types/domain';

interface MedicationWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  patient: Patient;
  existingPlan?: PatientMedicationPlan;
}

const DEFAULT_SLOT_TIMES = ['08:00', '14:00', '20:00', '23:00', '06:00', '12:00', '18:00', '22:00'];

function buildDefaultSlots(count: number, doseAmount: number): DoseTimeSlot[] {
  return Array.from({ length: Math.max(1, count) }, (_, idx) => ({
    id: `slot-${Date.now()}-${idx}`,
    time24: DEFAULT_SLOT_TIMES[idx % DEFAULT_SLOT_TIMES.length],
    doseAmount: doseAmount > 0 ? doseAmount : 1,
  }));
}

export const MedicationWizardModal: React.FC<MedicationWizardModalProps> = ({
  isOpen,
  onClose,
  patient,
  existingPlan,
}) => {
  const {
    lang,
    state,
    todayStr,
    use12Hour,
    setUse12Hour,
    backendCapabilities,
    refreshBackendCapabilities,
    addMedicationPlan,
    updateMedicationPlan,
    pushToast,
  } = useCrm();
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [stepErrors, setStepErrors] = useState<string[]>([]);
  const [confirmDuplicateMed, setConfirmDuplicateMed] = useState(false);
  const [allergyOverride, setAllergyOverride] = useState<AllergyOverrideAuthorization>({
    acknowledged: false,
    authorizationSource: 'prescriber_written_order',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLockRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  // Step 1 state
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogId, setCatalogId] = useState<string | undefined>(existingPlan?.catalogId);
  const [brandName, setBrandName] = useState(existingPlan?.brandName ?? '');
  const [genericName, setGenericName] = useState(existingPlan?.genericName ?? '');
  const [strength, setStrength] = useState(existingPlan?.strength ?? '');
  const [dosageForm, setDosageForm] = useState<DosageForm>(existingPlan?.dosageForm ?? 'tablet');
  const [route, setRoute] = useState<AdministrationRoute>(existingPlan?.route ?? 'oral');
  // Clinical safety: never auto-fill doseAmount from catalog drug name; starts empty for new meds
  const [doseAmountStr, setDoseAmountStr] = useState(
    existingPlan ? String(existingPlan.doseAmount) : ''
  );
  const [doseUnit, setDoseUnit] = useState(
    existingPlan?.doseUnit ?? (isAr ? 'قرص' : 'tablet')
  );
  const [foodRelation, setFoodRelation] = useState<FoodRelation>(
    existingPlan?.foodRelation ?? 'after_food'
  );
  const [verifiedInstructions, setVerifiedInstructions] = useState(
    existingPlan?.verifiedInstructions ?? ''
  );
  const [prescriberName, setPrescriberName] = useState(existingPlan?.prescriberName ?? '');
  const [prescriberSpecialty, setPrescriberSpecialty] = useState(
    existingPlan?.prescriberSpecialty ?? ''
  );

  // Step 2 & 3 state
  const [frequencyType, setFrequencyType] = useState<ScheduleFrequencyType>(
    existingPlan?.schedule.frequencyType ?? 'daily'
  );
  const [timesPerDay, setTimesPerDay] = useState<number>(
    existingPlan?.schedule.timesPerDay ?? 1
  );
  const [intervalValue, setIntervalValue] = useState<number>(
    existingPlan?.schedule.intervalValue ?? 8
  );
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(
    existingPlan?.schedule.intervalUnit ?? 'hours'
  );
  const [selectedWeekdays, setSelectedWeekdays] = useState<WeekdayIndex[]>(
    existingPlan?.schedule.selectedWeekdays ?? [0, 2, 4]
  );
  const [cycleOnDays, setCycleOnDays] = useState<number>(
    existingPlan?.schedule.cycleOnDays ?? 21
  );
  const [cycleOffDays, setCycleOffDays] = useState<number>(
    existingPlan?.schedule.cycleOffDays ?? 7
  );
  const [variablePatternNote, setVariablePatternNote] = useState(
    existingPlan?.schedule.variablePatternNote ?? ''
  );
  const [prnIndication, setPrnIndication] = useState(
    existingPlan?.schedule.prnIndication ?? ''
  );
  const [prnMaxPerDay, setPrnMaxPerDay] = useState<number>(
    existingPlan?.schedule.prnMaxPerDay ?? 4
  );
  const [doseSlots, setDoseSlots] = useState<DoseTimeSlot[]>(
    existingPlan?.schedule.doseSlots ?? buildDefaultSlots(1, 1)
  );
  const [slotsCustomized, setSlotsCustomized] = useState<boolean>(Boolean(existingPlan));

  // Step 4 state
  const [startDate, setStartDate] = useState(existingPlan?.startDate ?? todayStr);
  const [durationMode, setDurationMode] = useState<'ongoing' | 'end_date' | 'days'>(
    existingPlan
      ? existingPlan.isOngoing
        ? 'ongoing'
        : existingPlan.durationDays
          ? 'days'
          : 'end_date'
      : 'ongoing'
  );
  const [endDate, setEndDate] = useState(
    existingPlan?.endDate ?? addDaysToDate(todayStr, 30)
  );
  const [durationDays, setDurationDays] = useState<number>(existingPlan?.durationDays ?? 30);
  const [changeReason, setChangeReason] = useState('');

  const filteredCatalog = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    if (!q) return MEDICATION_CATALOG;
    return MEDICATION_CATALOG.filter(
      (item) =>
        item.brandName.toLowerCase().includes(q) ||
        item.genericName.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
    );
  }, [catalogSearch]);

  const isPatientArchived = patient.status !== 'active';
  const editAllowance = existingPlan
    ? validateMedicationEditAllowed(existingPlan, lang, existingPlan.currentVersionNumber)
    : { allowed: true };
  const isWizardBlocked = isPatientArchived || !editAllowance.allowed;
  const wizardBlockedReason = isPatientArchived
    ? isAr
      ? 'ملف المراجع مؤرشف. لا يمكن إضافة أو تعديل خطط دوائية قبل استعادة الملف.'
      : 'Patient record is archived. Restore the patient record before adding or editing medication plans.'
    : editAllowance.error;

  const allergyAssessment = useMemo(
    () =>
      assessMedicationAllergyRisk(
        patient,
        {
          catalogId,
          brandName,
          genericName,
          strength,
        },
        lang
      ),
    [patient, catalogId, brandName, genericName, strength, lang]
  );

  const drugIdentityKey = `${catalogId ?? ''}|${brandName.trim().toLowerCase()}|${genericName.trim().toLowerCase()}`;
  const prevDrugIdentityRef = useRef<string>(drugIdentityKey);
  useEffect(() => {
    if (prevDrugIdentityRef.current !== drugIdentityKey) {
      prevDrugIdentityRef.current = drugIdentityKey;
      setAllergyOverride({
        acknowledged: false,
        authorizationSource: 'prescriber_written_order',
      });
    }
  }, [drugIdentityKey]);

  if (!isOpen) return null;

  const parsedDoseAmount = Number(doseAmountStr);

  const selectCatalogItem = (item: MedicationCatalogItem) => {
    setCatalogId(item.id);
    setBrandName(item.brandName);
    setGenericName(item.genericName);
    setStrength(item.availableStrengths[0] ?? '');
    setDosageForm(item.defaultDosageForm);
    setRoute(item.defaultRoute);
    const defaultUnitMap: Record<DosageForm, string> = {
      tablet: isAr ? 'قرص' : 'tablet',
      capsule: isAr ? 'كبسولة' : 'capsule',
      syrup: isAr ? 'مل' : 'mL',
      injection: isAr ? 'وحدة / حقنة' : 'IU / inj',
      inhaler: isAr ? 'بخة' : 'puff',
      drops: isAr ? 'قطرة' : 'drop',
      cream: isAr ? 'تطبيق موضعي' : 'application',
      sachet: isAr ? 'كيس' : 'sachet',
    };
    setDoseUnit(defaultUnitMap[item.defaultDosageForm]);
    // Explicitly clear doseAmount so pharmacist must enter verified prescribed dose
    setDoseAmountStr('');
  };

  const handleDosageFormChange = (nextForm: DosageForm) => {
    setDosageForm(nextForm);
    const allowedRoutes = ALLOWED_ROUTES_BY_DOSAGE_FORM[nextForm];
    if (!allowedRoutes.includes(route)) {
      setRoute(allowedRoutes[0]);
    }
  };

  const buildScheduleObject = (): DoseSchedule => ({
    frequencyType,
    timesPerDay: frequencyType === 'prn' ? 0 : timesPerDay,
    intervalValue: frequencyType === 'interval' ? intervalValue : undefined,
    intervalUnit: frequencyType === 'interval' ? intervalUnit : undefined,
    selectedWeekdays: frequencyType === 'weekdays' ? selectedWeekdays : undefined,
    cycleOnDays: frequencyType === 'cyclic' ? cycleOnDays : undefined,
    cycleOffDays: frequencyType === 'cyclic' ? cycleOffDays : undefined,
    variablePatternNote: frequencyType === 'variable' ? variablePatternNote.trim() : undefined,
    prnIndication: frequencyType === 'prn' ? prnIndication.trim() : undefined,
    prnMaxPerDay: frequencyType === 'prn' ? prnMaxPerDay : undefined,
    doseSlots: frequencyType === 'prn' ? [] : doseSlots,
    timezone: 'Asia/Baghdad',
  });

  const handleFrequencyChange = (nextType: ScheduleFrequencyType) => {
    setFrequencyType(nextType);
    const baseDose = parsedDoseAmount > 0 ? parsedDoseAmount : 1;
    if (nextType === 'prn') {
      setTimesPerDay(0);
    } else if (nextType === 'interval' && intervalUnit === 'hours') {
      setTimesPerDay(1);
      setDoseSlots((prev) =>
        prev.length > 0 ? [prev[0]] : buildDefaultSlots(1, baseDose)
      );
    } else if (nextType === 'daily') {
      const targetCount = Math.max(1, timesPerDay || 1);
      setTimesPerDay(targetCount);
      setDoseSlots((prev) => {
        if (prev.length === targetCount) return prev;
        if (prev.length > targetCount) return prev.slice(0, targetCount);
        const extra = Array.from({ length: targetCount - prev.length }, (_, i) => ({
          id: `slot-${Date.now()}-${prev.length + i}`,
          time24: DEFAULT_SLOT_TIMES[(prev.length + i) % DEFAULT_SLOT_TIMES.length],
          doseAmount: baseDose,
        }));
        return [...prev, ...extra];
      });
    } else if (doseSlots.length === 0) {
      setTimesPerDay(1);
      setDoseSlots(buildDefaultSlots(1, baseDose));
    }
  };

  const handleTimesPerDayChange = (count: number) => {
    const safeCount = Math.max(1, Math.min(8, count));
    setTimesPerDay(safeCount);
    const baseDose = parsedDoseAmount > 0 ? parsedDoseAmount : 1;
    setDoseSlots((prev) => {
      if (prev.length === safeCount) return prev;
      if (prev.length > safeCount) return prev.slice(0, safeCount);
      const extra = Array.from({ length: safeCount - prev.length }, (_, i) => ({
        id: `slot-${Date.now()}-${prev.length + i}`,
        time24: DEFAULT_SLOT_TIMES[(prev.length + i) % DEFAULT_SLOT_TIMES.length],
        doseAmount: baseDose,
      }));
      return [...prev, ...extra];
    });
  };

  const toggleWeekday = (day: WeekdayIndex) => {
    setSelectedWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()
    );
  };

  const validateStep1 = (): string[] => {
    const errs: string[] = [];
    if (isWizardBlocked && wizardBlockedReason) {
      errs.push(wizardBlockedReason);
      return errs;
    }
    if (!brandName.trim() && !genericName.trim()) {
      errs.push(
        isAr
          ? 'يرجى إدخال الاسم التجاري أو العلمي للدواء.'
          : 'Enter medication brand or generic name.'
      );
    }
    if (!strength.trim()) {
      errs.push(isAr ? 'يرجى تحديد التركيز الدوائي.' : 'Strength is required.');
    }
    if (!Number.isFinite(parsedDoseAmount) || parsedDoseAmount <= 0) {
      errs.push(
        isAr
          ? 'يجب إدخال مقدار الجرعة الموصوفة يدوياً (أكبر من صفر).'
          : 'Prescribed dose amount must be entered (> 0).'
      );
    } else if (parsedDoseAmount > MAX_REASONABLE_DOSE_AMOUNT) {
      errs.push(
        isAr
          ? `مقدار الجرعة (${parsedDoseAmount}) يتجاوز الحد الأقصى الآمن (${MAX_REASONABLE_DOSE_AMOUNT}).`
          : `Dose amount (${parsedDoseAmount}) exceeds safety limit (${MAX_REASONABLE_DOSE_AMOUNT}).`
      );
    }
    const unitCheck = validateDosageFormUnitCompatibility(dosageForm, doseUnit, lang);
    if (!unitCheck.valid && unitCheck.error) {
      errs.push(unitCheck.error);
    }
    const routeCheck = validateDosageFormRouteCompatibility(dosageForm, route, lang);
    if (!routeCheck.valid && routeCheck.error) {
      errs.push(routeCheck.error);
    }
    if (verifiedInstructions.trim().length < 5) {
      errs.push(
        isAr
          ? 'يرجى كتابة تعليمات الاستخدام الموثقة (٥ أحرف على الأقل).'
          : 'Please enter verified administration instructions.'
      );
    }
    if (allergyAssessment.requiresPharmacistAcknowledgment) {
      const overrideCheck = validateAllergyOverrideAuthorization(
        allergyAssessment,
        allergyOverride,
        lang
      );
      if (!overrideCheck.valid) {
        errs.push(...overrideCheck.errors);
      }
    }
    return errs;
  };

  const handleNext = () => {
    if (isWizardBlocked) {
      setStepErrors(wizardBlockedReason ? [wizardBlockedReason] : []);
      return;
    }
    if (step === 1) {
      const errs = validateStep1();
      if (errs.length > 0) {
        setStepErrors(errs);
        return;
      }
      // Sync default slot dose amounts only if user has not customized slots in Step 3 yet
      if (!existingPlan && !slotsCustomized && doseSlots.length > 0) {
        setDoseSlots((prev) =>
          prev.map((s) => ({ ...s, doseAmount: parsedDoseAmount > 0 ? parsedDoseAmount : s.doseAmount }))
        );
      }
      setStepErrors([]);
      setStep(2);
      return;
    }

    if (step === 2) {
      const sched = buildScheduleObject();
      if (frequencyType !== 'prn' && sched.doseSlots.length === 0) {
        setDoseSlots(buildDefaultSlots(1, parsedDoseAmount || 1));
      }
      const check = validateSchedule(
        {
          ...sched,
          doseSlots:
            frequencyType === 'prn'
              ? []
              : sched.doseSlots.length > 0
                ? sched.doseSlots
                : buildDefaultSlots(1, parsedDoseAmount || 1),
        },
        lang
      );
      if (!check.valid) {
        setStepErrors(check.errors);
        return;
      }
      setStepErrors([]);
      setStep(3);
      return;
    }

    if (step === 3) {
      const check = validateSchedule(buildScheduleObject(), lang);
      if (!check.valid) {
        setStepErrors(check.errors);
        return;
      }
      setStepErrors([]);
      setStep(4);
    }
  };

  const handleDurationDaysChange = (days: number) => {
    const safe = Math.max(1, days);
    setDurationDays(safe);
    if (startDate) {
      setEndDate(addDaysToDate(startDate, safe));
    }
  };

  const handleEndDateChange = (nextEnd: string) => {
    setEndDate(nextEnd);
    if (isValidIsoCalendarDate(startDate) && isValidIsoCalendarDate(nextEnd)) {
      const diff = diffDaysBetween(startDate, nextEnd);
      if (diff >= 0) {
        setDurationDays(Math.max(1, diff));
      }
    }
  };

  const duplicateActiveMed = findDuplicateActiveMedication(
    state.medicationPlans,
    patient.id,
    genericName.trim() || brandName.trim(),
    strength.trim(),
    existingPlan?.id
  );

  const handleSave = async () => {
    if (submitLockRef.current || isSubmitting) return;
    const errs: string[] = [];

    if (isWizardBlocked && wizardBlockedReason) {
      errs.push(wizardBlockedReason);
    }

    if (!isValidIsoCalendarDate(startDate)) {
      errs.push(
        isAr
          ? 'تاريخ بداية العلاج غير صالح.'
          : 'Treatment start date must be a valid calendar date.'
      );
    }
    if (durationMode !== 'ongoing') {
      if (!isValidIsoCalendarDate(endDate)) {
        errs.push(
          isAr
            ? 'تاريخ انتهاء العلاج غير صالح.'
            : 'Treatment end date must be a valid calendar date.'
        );
      } else if (isValidIsoCalendarDate(startDate) && endDate < startDate) {
        errs.push(
          isAr
            ? 'تاريخ الانتهاء لا يمكن أن يكون قبل تاريخ البداية.'
            : 'End date cannot precede start date.'
        );
      }
      if (!Number.isFinite(durationDays) || !Number.isInteger(durationDays) || durationDays < 1) {
        errs.push(
          isAr
            ? 'عدد أيام العلاج يجب أن يكون عدداً صحيحاً موجباً (١ يوم على الأقل).'
            : 'Duration days must be a positive integer (>= 1).'
        );
      }
    }

    const sched = buildScheduleObject();
    const payload = {
      patientId: patient.id,
      catalogId,
      brandName: brandName.trim() || genericName.trim(),
      genericName: genericName.trim() || brandName.trim(),
      strength: strength.trim(),
      dosageForm,
      route,
      doseAmount: parsedDoseAmount,
      doseUnit: doseUnit.trim(),
      foodRelation,
      verifiedInstructions: verifiedInstructions.trim(),
      prescriberName: prescriberName.trim() || undefined,
      prescriberSpecialty: prescriberSpecialty.trim() || undefined,
      startDate,
      isOngoing: durationMode === 'ongoing',
      endDate: durationMode === 'ongoing' ? undefined : endDate,
      durationDays: durationMode === 'ongoing' ? undefined : durationDays,
      schedule: sched,
    };

    const planCheck = validateMedicationPlanInput(payload, lang);
    if (!planCheck.valid) {
      for (const e of planCheck.errors) {
        if (!errs.includes(e)) errs.push(e);
      }
    }

    if (allergyAssessment.requiresPharmacistAcknowledgment) {
      const overrideCheck = validateAllergyOverrideAuthorization(
        allergyAssessment,
        allergyOverride,
        lang
      );
      if (!overrideCheck.valid) {
        for (const e of overrideCheck.errors) {
          if (!errs.includes(e)) errs.push(e);
        }
      }
    }

    if (existingPlan && changeReason.trim().length < 3) {
      errs.push(
        isAr
          ? 'يرجى توضيح سبب تعديل الخطة (٣ أحرف على الأقل) لحفظ النسخة السابقة في السجل.'
          : 'Please specify a reason for regimen change (at least 3 characters) to preserve previous version.'
      );
    }

    if (duplicateActiveMed && !confirmDuplicateMed) {
      errs.push(
        isAr
          ? `توجد خطة نشطة مطابقة لهذا الدواء (${duplicateActiveMed.brandName} ${duplicateActiveMed.strength}). يرجى تأكيد خيار السماح بالإضافة المكررة أو تعديل الخطة الموجودة.`
          : `An active plan for ${duplicateActiveMed.brandName} ${duplicateActiveMed.strength} already exists. Please confirm duplicate addition or edit the existing plan.`
      );
    }

    if (errs.length > 0) {
      setStepErrors(errs);
      return;
    }

    submitLockRef.current = true;
    setStepErrors([]);
    setIsSubmitting(true);
    try {
      const overrideToSend = allergyAssessment.requiresPharmacistAcknowledgment
        ? allergyOverride
        : undefined;
      if (existingPlan) {
        await updateMedicationPlan(
          existingPlan.id,
          payload,
          changeReason.trim(),
          existingPlan.currentVersionNumber,
          overrideToSend
        );
        pushToast(
          isAr
            ? `تم تحديث الخطة وحفظ النسخة رقم ${existingPlan.currentVersionNumber + 1}.`
            : `Regimen updated (saved as version #${existingPlan.currentVersionNumber + 1}).`
        );
      } else {
        await addMedicationPlan(payload, overrideToSend);
        pushToast(
          isAr
            ? `تمت إضافة ${payload.brandName} إلى ملف ${patient.fullName}.`
            : `Added ${payload.brandName} to ${patient.fullName}'s profile.`
        );
      }
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : isAr
            ? 'تعذر حفظ الخطة الدوائية.'
            : 'Unable to save medication plan.';
      setStepErrors([msg]);
      pushToast(msg, 'error');
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  };

  const selectedCatalog = MEDICATION_CATALOG.find((c) => c.id === catalogId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="medication-wizard-title"
    >
      <div className="bg-white w-full h-full sm:h-auto sm:max-h-[94vh] sm:max-w-3xl sm:rounded-xl border border-slate-200 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 id="medication-wizard-title" className="text-lg font-bold text-[#103354]">
              {existingPlan
                ? isAr
                  ? `تعديل الخطة الدوائية (${existingPlan.brandName})`
                  : `Edit Medication Plan (${existingPlan.brandName})`
                : isAr
                  ? 'معالج إضافة وجدولة علاج جديد'
                  : 'Advanced Medication Scheduling Wizard'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {patient.fullName} · {isAr ? `الخطوة ${step} من ٤` : `Step ${step} of 4`} ·{' '}
              {t.common.baghdadTz}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 min-h-[40px] min-w-[40px] flex items-center justify-center"
            aria-label={t.common.close}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 4-Step Progress Bar */}
        <div className="px-5 py-3 bg-[#F5F7FA] border-b border-slate-200 grid grid-cols-4 gap-2">
          {[
            { num: 1, labelAr: '١. تفاصيل الدواء', labelEn: '1. Details' },
            { num: 2, labelAr: '٢. نمط التكرار', labelEn: '2. Frequency' },
            { num: 3, labelAr: '٣. أوقات الجرعات', labelEn: '3. Dose Times' },
            { num: 4, labelAr: '٤. المدة والمراجعة', labelEn: '4. Duration' },
          ].map((s) => (
            <button
              key={s.num}
              type="button"
              onClick={() => {
                if (s.num < step) {
                  setStepErrors([]);
                  setStep(s.num as 1 | 2 | 3 | 4);
                }
              }}
              className={`text-xs font-semibold py-2 px-2 rounded-lg text-center transition-colors border ${
                step === s.num
                  ? 'bg-[#103354] text-white border-[#103354]'
                  : step > s.num
                    ? 'bg-teal-50 text-[#008C87] border-teal-200 cursor-pointer'
                    : 'bg-white text-slate-400 border-slate-200 cursor-default'
              }`}
            >
              {isAr ? s.labelAr : s.labelEn}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {isWizardBlocked && wizardBlockedReason && (
            <div
              role="alert"
              className="p-3.5 bg-[#FEF2F2] border border-[#A80000] rounded-[6px] text-xs text-[#A80000] flex items-start gap-2 font-semibold"
            >
              <AlertOctagon className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{wizardBlockedReason}</span>
            </div>
          )}

          {stepErrors.length > 0 && (
            <div className="p-3 bg-[#FEF2F2] border border-[#A80000] rounded-[6px] text-xs text-[#A80000] space-y-1">
              <div className="flex items-center gap-2 font-semibold">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{isAr ? 'يرجى التحقق مما يلي:' : 'Please check:'}</span>
              </div>
              <ul className="list-disc list-inside space-y-0.5">
                {stepErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          {/* STEP 1: MEDICATION DETAILS */}
          {step === 1 && (
            <div className="space-y-4">
              {!existingPlan && (
                <div className="p-3.5 bg-[#F5F7FA] border border-slate-200 rounded-lg space-y-2.5">
                  <label className="block text-xs font-semibold text-[#103354]">
                    {isAr
                      ? 'بحث سريع في الدليل الدوائي المرجعي (اختياري — لا يحدد الجرعة تلقائياً)'
                      : 'Quick search reference catalog (optional — never auto-infers dose)'}
                  </label>
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-400 absolute top-3 start-3" />
                    <input
                      type="text"
                      value={catalogSearch}
                      onChange={(e) => setCatalogSearch(e.target.value)}
                      placeholder={
                        isAr
                          ? 'ابحث بالاسم التجاري أو العلمي (مثل: Glucophage, Metformin)...'
                          : 'Search brand or generic...'
                      }
                      className="w-full ps-9 pe-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:border-[#008C87] focus:outline-none"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                    {filteredCatalog.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => selectCatalogItem(item)}
                        className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
                          catalogId === item.id
                            ? 'bg-[#008C87] text-white border-[#008C87]'
                            : 'bg-white text-slate-700 border-slate-200 hover:border-[#008C87]'
                        }`}
                      >
                        {item.brandName} ({item.genericName})
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'الاسم التجاري *' : 'Brand Name *'}
                  </label>
                  <input
                    type="text"
                    value={brandName}
                    onChange={(e) => setBrandName(e.target.value)}
                    placeholder="Glucophage"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'الاسم العلمي *' : 'Generic Name *'}
                  </label>
                  <input
                    type="text"
                    value={genericName}
                    onChange={(e) => setGenericName(e.target.value)}
                    placeholder="Metformin HCl"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'التركيز (Strength) *' : 'Strength *'}
                  </label>
                  {selectedCatalog && selectedCatalog.availableStrengths.length > 0 ? (
                    <div className="flex gap-1.5 flex-wrap mb-1.5">
                      {selectedCatalog.availableStrengths.map((str) => (
                        <button
                          key={str}
                          type="button"
                          onClick={() => setStrength(str)}
                          className={`px-2.5 py-1 text-xs rounded border ${
                            strength === str
                              ? 'bg-[#103354] text-white border-[#103354]'
                              : 'bg-slate-50 text-slate-700 border-slate-200'
                          }`}
                        >
                          {str}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <input
                    type="text"
                    value={strength}
                    onChange={(e) => setStrength(e.target.value)}
                    placeholder="500 mg"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'الشكل الصيدلاني' : 'Dosage Form'}
                  </label>
                  <select
                    value={dosageForm}
                    onChange={(e) => handleDosageFormChange(e.target.value as DosageForm)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {(Object.keys(t.dosageForms) as DosageForm[]).map((df) => (
                      <option key={df} value={df}>
                        {t.dosageForms[df]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'طريق الإعطاء' : 'Administration Route'}
                  </label>
                  <select
                    value={route}
                    onChange={(e) => setRoute(e.target.value as AdministrationRoute)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    {(
                      [
                        { value: 'oral', label: isAr ? 'عن طريق الفم (Oral)' : 'Oral' },
                        { value: 'inhalation', label: isAr ? 'استنشاق (Inhalation)' : 'Inhalation' },
                        { value: 'subcutaneous', label: isAr ? 'تحت الجلد (SC)' : 'Subcutaneous' },
                        { value: 'intramuscular', label: isAr ? 'عضلي (IM)' : 'Intramuscular' },
                        { value: 'intravenous', label: isAr ? 'وريدي (IV)' : 'Intravenous' },
                        { value: 'topical', label: isAr ? 'موضعي (Topical)' : 'Topical' },
                        { value: 'ophthalmic', label: isAr ? 'عيني (Ophthalmic)' : 'Ophthalmic' },
                        { value: 'otic', label: isAr ? 'أذني (Otic)' : 'Otic' },
                      ] as const
                    ).map((opt) => {
                      const allowed = ALLOWED_ROUTES_BY_DOSAGE_FORM[dosageForm].includes(opt.value);
                      return (
                        <option key={opt.value} value={opt.value} disabled={!allowed}>
                          {opt.label}
                          {!allowed ? (isAr ? ' (غير متوافق)' : ' (Incompatible)') : ''}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'الجرعة الموصوفة في المرة الواحدة *' : 'Exact Prescribed Dose *'}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      step="any"
                      min="0.25"
                      max={MAX_REASONABLE_DOSE_AMOUNT}
                      value={doseAmountStr}
                      onChange={(e) => setDoseAmountStr(e.target.value)}
                      placeholder="1"
                      className="w-24 px-3 py-2 text-sm font-bold text-[#103354] border border-slate-300 rounded-lg tabular-nums"
                    />
                    <input
                      type="text"
                      value={doseUnit}
                      onChange={(e) => setDoseUnit(e.target.value)}
                      placeholder={isAr ? 'قرص / كبسولة / مل' : 'tablet / mL / puff'}
                      className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
              </div>

              {(brandName.trim() || genericName.trim()) && (
                <AllergySafetyBanner
                  assessment={allergyAssessment}
                  acknowledged={allergyOverride.acknowledged}
                  onAcknowledgeChange={(checked) =>
                    setAllergyOverride((prev) => ({ ...prev, acknowledged: checked }))
                  }
                  overrideAuth={allergyOverride}
                  onOverrideAuthChange={setAllergyOverride}
                  backendCapabilities={backendCapabilities}
                  onRefreshCapabilities={refreshBackendCapabilities}
                  lang={lang}
                />
              )}

              {/* Food relation */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  {isAr ? 'العلاقة بالطعام' : 'Food Relation'}
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {(Object.keys(t.foodRelations) as FoodRelation[]).map((fr) => (
                    <button
                      key={fr}
                      type="button"
                      onClick={() => setFoodRelation(fr)}
                      className={`py-2 px-3 text-xs font-medium rounded-lg border transition-colors min-h-[40px] ${
                        foodRelation === fr
                          ? 'bg-[#008C87] text-white border-[#008C87]'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {t.foodRelations[fr]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {isAr
                    ? 'تعليمات الاستخدام الموثقة من الصيدلي / الوصفة *'
                    : 'Verified Administration Instructions *'}
                </label>
                <textarea
                  rows={2}
                  value={verifiedInstructions}
                  onChange={(e) => setVerifiedInstructions(e.target.value)}
                  placeholder={
                    isAr
                      ? 'مثال: قرص واحد بعد وجبة الإفطار والعشاء مع كوب ماء...'
                      : 'e.g. Take 1 tablet after breakfast and dinner with water...'
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'اسم الطبيب الواصف (إن وجد)' : 'Prescriber Name (if known)'}
                  </label>
                  <input
                    type="text"
                    value={prescriberName}
                    onChange={(e) => setPrescriberName(e.target.value)}
                    placeholder={isAr ? 'د. طارق النعيمي' : 'Dr. Tariq Al-Nuaimi'}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'التخصص (اختياري)' : 'Specialty (optional)'}
                  </label>
                  <input
                    type="text"
                    value={prescriberSpecialty}
                    onChange={(e) => setPrescriberSpecialty(e.target.value)}
                    placeholder={isAr ? 'باطنية / قلبية' : 'Internal Medicine'}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: FREQUENCY */}
          {step === 2 && (
            <div className="space-y-3">
              <p className="text-xs text-slate-600">
                {isAr
                  ? 'اختر نمطاً واحداً فقط لمنع تعارض الجداول الحسابية:'
                  : 'Select a single scheduling pattern (incompatible options are isolated):'}
              </p>

              {(
                [
                  {
                    key: 'daily',
                    titleAr: 'يومياً',
                    descAr: 'مرة واحدة، مرتين، ثلاث مرات أو أكثر يومياً',
                    titleEn: 'Daily',
                    descEn: 'Once, twice, three or more times per day',
                  },
                  {
                    key: 'interval',
                    titleAr: 'فاصلة زمنية محددة',
                    descAr: 'مثال: كل ٨ ساعات، كل يومين، كل أسبوع',
                    titleEn: 'Fixed Interval',
                    descEn: 'e.g. Every 8 hours, every 2 days, every week',
                  },
                  {
                    key: 'weekdays',
                    titleAr: 'أيام محددة بالأسبوع',
                    descAr: 'مثال: كل أحد وثلاثاء وخميس',
                    titleEn: 'Selected Weekdays',
                    descEn: 'e.g. Every Sun, Tue, Thu',
                  },
                  {
                    key: 'cyclic',
                    titleAr: 'دورة علاجية مخصصة',
                    descAr: 'مثال: ٢١ يوم علاج ثم ٧ أيام توقف',
                    titleEn: 'Treatment Cycle',
                    descEn: 'e.g. 21 days ON followed by 7 days OFF',
                  },
                  {
                    key: 'variable',
                    titleAr: 'جدول متغير الجرعة',
                    descAr: 'للتدريج أو الجرعات المتناوبة حسب التحاليل (مثل الوارفارين)',
                    titleEn: 'Variable Dosing',
                    descEn: 'Tapering or alternating doses (e.g. Warfarin)',
                  },
                  {
                    key: 'prn',
                    titleAr: 'عند اللزوم (PRN)',
                    descAr: 'دواء إسعافي أو حسب الأعراض — لا يُجدول بأوقات إلزامية',
                    titleEn: 'As Needed (PRN)',
                    descEn: 'Symptom-driven rescue therapy handled separately',
                  },
                ] as const
              ).map((opt) => {
                const active = frequencyType === opt.key;
                return (
                  <div
                    key={opt.key}
                    className={`rounded-xl border transition-colors ${
                      active ? 'border-[#008C87] bg-teal-50/40' : 'border-slate-200 bg-white'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleFrequencyChange(opt.key)}
                      className="w-full flex items-center justify-between p-4 text-start"
                    >
                      <div>
                        <div className="text-sm font-bold text-[#103354]">
                          {isAr ? opt.titleAr : opt.titleEn}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {isAr ? opt.descAr : opt.descEn}
                        </div>
                      </div>
                      <span
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                          active ? 'border-[#008C87] bg-[#008C87] text-white' : 'border-slate-300'
                        }`}
                      >
                        {active && <Check className="w-3 h-3" />}
                      </span>
                    </button>

                    {active && opt.key === 'daily' && (
                      <div className="px-4 pb-4 pt-2 border-t border-teal-200/60 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-slate-700 me-2">
                          {isAr ? 'عدد المرات يومياً:' : 'Times per day:'}
                        </span>
                        {[1, 2, 3, 4].map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => handleTimesPerDayChange(n)}
                            className={`px-3.5 py-2 text-xs font-bold rounded-lg border min-w-[44px] ${
                              timesPerDay === n
                                ? 'bg-[#103354] text-white border-[#103354]'
                                : 'bg-white text-slate-700 border-slate-300'
                            }`}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    )}

                    {active && opt.key === 'interval' && (
                      <div className="px-4 pb-4 pt-2 border-t border-teal-200/60 space-y-2.5">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="text-xs font-semibold text-slate-700">
                            {isAr ? 'يؤخذ كل:' : 'Every:'}
                          </span>
                          <input
                            type="number"
                            min={1}
                            max={intervalUnit === 'hours' ? 720 : 365}
                            value={intervalValue}
                            onChange={(e) => setIntervalValue(Number(e.target.value))}
                            className="w-20 px-3 py-2 text-sm font-bold border border-slate-300 rounded-lg bg-white tabular-nums"
                          />
                          <select
                            value={intervalUnit}
                            onChange={(e) => {
                              const nextUnit = e.target.value as IntervalUnit;
                              setIntervalUnit(nextUnit);
                              if (nextUnit === 'hours' && doseSlots.length > 1) {
                                setDoseSlots((prev) => [prev[0]]);
                                setTimesPerDay(1);
                              }
                            }}
                            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                          >
                            <option value="hours">{isAr ? 'ساعة' : 'Hours'}</option>
                            <option value="days">{isAr ? 'يوم' : 'Days'}</option>
                            <option value="weeks">{isAr ? 'أسبوع' : 'Weeks'}</option>
                          </select>
                        </div>
                        {intervalUnit === 'hours' && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[11px] text-slate-500 me-1">
                              {isAr ? 'فواصل شائعة:' : 'Common intervals:'}
                            </span>
                            {[8, 12, 24, 36, 48].map((h) => (
                              <button
                                key={h}
                                type="button"
                                onClick={() => {
                                  setIntervalValue(h);
                                  if (doseSlots.length > 1) {
                                    setDoseSlots((prev) => [prev[0]]);
                                    setTimesPerDay(1);
                                  }
                                }}
                                className={`px-2.5 py-1 text-xs font-semibold rounded border tabular-nums ${
                                  intervalValue === h
                                    ? 'bg-[#103354] text-white border-[#103354]'
                                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                                }`}
                              >
                                {isAr ? `${h} س` : `${h}h`}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {active && opt.key === 'weekdays' && (
                      <div className="px-4 pb-4 pt-2 border-t border-teal-200/60 space-y-3">
                        <div className="flex flex-wrap gap-2">
                          {([0, 1, 2, 3, 4, 5, 6] as WeekdayIndex[]).map((dayIdx) => {
                            const picked = selectedWeekdays.includes(dayIdx);
                            return (
                              <button
                                key={dayIdx}
                                type="button"
                                onClick={() => toggleWeekday(dayIdx)}
                                className={`px-3 py-2 text-xs font-semibold rounded-lg border min-h-[38px] ${
                                  picked
                                    ? 'bg-[#103354] text-white border-[#103354]'
                                    : 'bg-white text-slate-700 border-slate-300'
                                }`}
                              >
                                {t.weekdaysShort[dayIdx]}
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-slate-700">
                            {isAr ? 'مرات الأخذ في كل يوم مختار:' : 'Times per selected day:'}
                          </span>
                          {[1, 2, 3].map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => handleTimesPerDayChange(n)}
                              className={`px-3 py-1.5 text-xs font-bold rounded-lg border ${
                                timesPerDay === n
                                  ? 'bg-[#008C87] text-white border-[#008C87]'
                                  : 'bg-white text-slate-700 border-slate-300'
                              }`}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {active && opt.key === 'cyclic' && (
                      <div className="px-4 pb-4 pt-2 border-t border-teal-200/60 grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 mb-1">
                            {isAr ? 'فترة أخذ العلاج (أيام)' : 'Active Days (ON)'}
                          </label>
                          <input
                            type="number"
                            min={1}
                            value={cycleOnDays}
                            onChange={(e) => setCycleOnDays(Number(e.target.value))}
                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular-nums"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 mb-1">
                            {isAr ? 'فترة التوقف (أيام)' : 'Break Days (OFF)'}
                          </label>
                          <input
                            type="number"
                            min={0}
                            value={cycleOffDays}
                            onChange={(e) => setCycleOffDays(Number(e.target.value))}
                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular-nums"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 mb-1">
                            {isAr ? 'مرات يومياً خلال الدورة' : 'Times/day when ON'}
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={6}
                            value={timesPerDay}
                            onChange={(e) => handleTimesPerDayChange(Number(e.target.value))}
                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular-nums"
                          />
                        </div>
                      </div>
                    )}

                    {active && opt.key === 'variable' && (
                      <div className="px-4 pb-4 pt-2 border-t border-teal-200/60">
                        <label className="block text-xs font-semibold text-slate-700 mb-1">
                          {isAr
                            ? 'وصف الجرعة المتغيرة بدقة (يظهر للمراجع في التنبيهات):'
                            : 'Describe variable dosing rule:'}
                        </label>
                        <input
                          type="text"
                          value={variablePatternNote}
                          onChange={(e) => setVariablePatternNote(e.target.value)}
                          placeholder={
                            isAr
                              ? 'مثال: ٥ ملغ (سبت/إثنين/أربعاء) و ٢.٥ ملغ باقي الأيام'
                              : 'e.g. 5mg Mon/Wed/Fri, 2.5mg other days'
                          }
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                        />
                      </div>
                    )}

                    {active && opt.key === 'prn' && (
                      <div className="px-4 pb-4 pt-2 border-t border-teal-200/60 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 mb-1">
                            {isAr ? 'داعي الاستعمال *' : 'Indication *'}
                          </label>
                          <input
                            type="text"
                            value={prnIndication}
                            onChange={(e) => setPrnIndication(e.target.value)}
                            placeholder={isAr ? 'ضيق التنفس / الألم الحاد' : 'Shortness of breath / Pain'}
                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 mb-1">
                            {isAr ? 'الحد الأقصى باليوم' : 'Max doses/day'}
                          </label>
                          <input
                            type="number"
                            min={1}
                            value={prnMaxPerDay}
                            onChange={(e) => setPrnMaxPerDay(Number(e.target.value))}
                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular-nums"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* STEP 3: DOSE TIMES */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-[#F5F7FA] border border-slate-200 rounded-lg">
                <div className="flex items-center gap-2 text-xs text-slate-700">
                  <Clock className="w-4 h-4 text-[#008C87]" />
                  <span>
                    {brandName} {strength} · {t.common.baghdadTz}
                  </span>
                </div>
                <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setUse12Hour(true)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded ${
                      use12Hour ? 'bg-[#103354] text-white' : 'text-slate-600'
                    }`}
                  >
                    12h
                  </button>
                  <button
                    type="button"
                    onClick={() => setUse12Hour(false)}
                    className={`px-2.5 py-1 text-xs font-semibold rounded ${
                      !use12Hour ? 'bg-[#103354] text-white' : 'text-slate-600'
                    }`}
                  >
                    24h
                  </button>
                </div>
              </div>

              {frequencyType === 'prn' ? (
                <div className="p-6 border border-slate-200 rounded-xl bg-amber-50/50 text-center space-y-2">
                  <p className="text-sm font-bold text-[#103354]">
                    {isAr
                      ? 'علاج عند اللزوم (PRN) — لا توجد منبهات يومية إلزامية'
                      : 'As-Needed (PRN) — No fixed daily alarm times required'}
                  </p>
                  <p className="text-xs text-slate-600">
                    {isAr
                      ? `داعي الاستعمال: ${prnIndication} · الحد الأقصى المسموح: ${prnMaxPerDay} باليوم.`
                      : `Indication: ${prnIndication} · Max per day: ${prnMaxPerDay}.`}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {doseSlots.map((slot, idx) => (
                    <div
                      key={slot.id}
                      className="flex flex-wrap items-center gap-3 p-3.5 border border-slate-200 rounded-xl bg-white"
                    >
                      <span className="text-xs font-bold text-slate-500 w-16">
                        {isAr ? `الجرعة ${idx + 1}` : `Dose ${idx + 1}`}
                      </span>

                      <div className="flex items-center gap-2">
                        <input
                          type="time"
                          value={slot.time24}
                          onChange={(e) =>
                            setDoseSlots((prev) =>
                              prev.map((s) =>
                                s.id === slot.id ? { ...s, time24: e.target.value } : s
                              )
                            )
                          }
                          className="px-3 py-2 text-sm font-mono font-semibold border border-slate-300 rounded-lg tabular-nums"
                        />
                        <span className="text-xs text-slate-500 tabular-nums">
                          ({formatTimeDisplay(slot.time24, use12Hour, lang)})
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <label className="text-xs text-slate-600">
                          {isAr ? 'المقدار:' : 'Qty:'}
                        </label>
                        <input
                          type="number"
                          step="any"
                          min="0.25"
                          value={slot.doseAmount}
                          onChange={(e) => {
                            setSlotsCustomized(true);
                            setDoseSlots((prev) =>
                              prev.map((s) =>
                                s.id === slot.id ? { ...s, doseAmount: Number(e.target.value) } : s
                              )
                            );
                          }}
                          className="w-20 px-2.5 py-2 text-sm font-bold text-[#103354] border border-slate-300 rounded-lg tabular-nums"
                        />
                        <span className="text-xs text-slate-600">{doseUnit}</span>
                      </div>

                      <input
                        type="text"
                        value={slot.label ?? ''}
                        onChange={(e) =>
                          setDoseSlots((prev) =>
                            prev.map((s) =>
                              s.id === slot.id ? { ...s, label: e.target.value } : s
                            )
                          )
                        }
                        placeholder={isAr ? 'تسمية (مثل: صباحاً)' : 'Label (e.g. Morning)'}
                        className="flex-1 min-w-[120px] px-3 py-2 text-xs border border-slate-200 rounded-lg"
                      />

                      {doseSlots.length > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            setDoseSlots((prev) => prev.filter((s) => s.id !== slot.id));
                            setTimesPerDay((prev) => Math.max(1, prev - 1));
                          }}
                          className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                          aria-label="Remove slot"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={() => {
                      const nextIdx = doseSlots.length;
                      setDoseSlots((prev) => [
                        ...prev,
                        {
                          id: `slot-${Date.now()}`,
                          time24: DEFAULT_SLOT_TIMES[nextIdx % DEFAULT_SLOT_TIMES.length],
                          doseAmount: parsedDoseAmount || 1,
                        },
                      ]);
                      setTimesPerDay((prev) => prev + 1);
                    }}
                    className="px-3.5 py-2 text-xs font-semibold text-[#008C87] border border-teal-300 bg-teal-50/50 hover:bg-teal-50 rounded-lg inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>{isAr ? 'إضافة موعد جرعة آخر' : 'Add another dose time'}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* STEP 4: DURATION & REVIEW */}
          {step === 4 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'تاريخ بداية العلاج *' : 'Treatment Start Date *'}
                  </label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => {
                      const nextStart = e.target.value;
                      setStartDate(nextStart);
                      if (durationMode === 'days' && nextStart) {
                        setEndDate(addDaysToDate(nextStart, durationDays));
                      }
                    }}
                    className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-700">
                  {isAr ? 'مدة العلاج' : 'Treatment Duration'}
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {[
                    {
                      id: 'ongoing' as const,
                      labelAr: 'بدون نهاية محددة (مستمر)',
                      labelEn: 'Ongoing (no end date)',
                    },
                    {
                      id: 'days' as const,
                      labelAr: 'يستمر لمدة X من الأيام',
                      labelEn: 'Duration in X days',
                    },
                    {
                      id: 'end_date' as const,
                      labelAr: 'تاريخ انتهاء محدد',
                      labelEn: 'Specific end date',
                    },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setDurationMode(opt.id)}
                      className={`p-3 text-xs font-semibold rounded-lg border text-start min-h-[44px] ${
                        durationMode === opt.id
                          ? 'bg-[#103354] text-white border-[#103354]'
                          : 'bg-white text-slate-700 border-slate-300'
                      }`}
                    >
                      {isAr ? opt.labelAr : opt.labelEn}
                    </button>
                  ))}
                </div>

                {durationMode === 'days' && (
                  <div className="p-3 bg-[#F5F7FA] border border-slate-200 rounded-lg flex flex-wrap items-center gap-3">
                    <span className="text-xs font-semibold text-slate-700">
                      {isAr ? 'عدد أيام العلاج:' : 'Number of days:'}
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={durationDays}
                      onChange={(e) => handleDurationDaysChange(Number(e.target.value))}
                      className="w-24 px-3 py-2 text-sm font-bold border border-slate-300 rounded-lg bg-white tabular-nums"
                    />
                    <span className="text-xs text-slate-500">
                      {isAr ? 'ينتهي في:' : 'Ends on:'} {formatDate(endDate, lang)}
                    </span>
                  </div>
                )}

                {durationMode === 'end_date' && (
                  <div className="p-3 bg-[#F5F7FA] border border-slate-200 rounded-lg flex flex-wrap items-center gap-3">
                    <span className="text-xs font-semibold text-slate-700">
                      {isAr ? 'تاريخ الانتهاء:' : 'End date:'}
                    </span>
                    <input
                      type="date"
                      value={endDate}
                      onChange={(e) => handleEndDateChange(e.target.value)}
                      className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular-nums"
                    />
                    <span className="text-xs text-slate-500 tabular-nums">
                      ({durationDays} {t.common.days})
                    </span>
                  </div>
                )}
              </div>

              {existingPlan && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr
                      ? 'سبب تعديل الخطة العلاجية (لحفظ النسخة التاريخية) *'
                      : 'Reason for Regimen Change (for version history) *'}
                  </label>
                  <input
                    type="text"
                    value={changeReason}
                    onChange={(e) => setChangeReason(e.target.value)}
                    placeholder={
                      isAr
                        ? 'مثال: تعديل الجرعة بناءً على توصية الطبيب المعالج'
                        : 'e.g. Dose adjustment per physician note'
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              )}

              {/* Final Summary Card */}
              <div className="p-4 bg-teal-50/60 border border-teal-200 rounded-xl space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold text-[#008C87]">
                  <Calendar className="w-4 h-4" />
                  <span>{isAr ? 'ملخص الخطة العلاجية قبل الحفظ' : 'Schedule Review Before Saving'}</span>
                </div>
                <div className="text-base font-bold text-[#103354]">
                  {brandName} ({genericName}) — {strength}
                </div>
                <div className="text-xs text-slate-600">
                  {t.dosageForms[dosageForm]} · {parsedDoseAmount} {doseUnit} ·{' '}
                  {t.foodRelations[foodRelation]}
                </div>
                <div className="text-sm font-semibold text-[#103354] pt-1">
                  {formatScheduleSummary(buildScheduleObject(), doseUnit, lang, use12Hour)}
                </div>
                <div className="text-xs text-slate-600">
                  {isAr ? 'البداية:' : 'Start:'} {formatDate(startDate, lang)} ·{' '}
                  {durationMode === 'ongoing'
                    ? isAr
                      ? 'علاج مستمر (مفتوح)'
                      : 'Ongoing treatment'
                    : `${isAr ? 'حتى' : 'Until'} ${formatDate(endDate, lang)} (${durationDays} ${t.common.days})`}
                </div>
                <div className="text-xs text-slate-700 pt-1 border-t border-teal-200/70">
                  {verifiedInstructions}
                </div>
              </div>
              <AllergySafetyBanner
                assessment={allergyAssessment}
                acknowledged={allergyOverride.acknowledged}
                onAcknowledgeChange={(checked) =>
                  setAllergyOverride((prev) => ({ ...prev, acknowledged: checked }))
                }
                overrideAuth={allergyOverride}
                onOverrideAuthChange={setAllergyOverride}
                backendCapabilities={backendCapabilities}
                lang={lang}
                compact
              />

              {duplicateActiveMed && (
                <div className="p-3.5 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-950 space-y-2">
                  <div className="flex items-start gap-2 font-semibold">
                    <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <span>
                      {isAr
                        ? `تنبيه تكرار دواء نشط: لدى المراجع خطة نشطة حالياً لدواء ${duplicateActiveMed.brandName} (${duplicateActiveMed.genericName} ${duplicateActiveMed.strength}).`
                        : `Duplicate Active Medication Warning: Patient already has an active plan for ${duplicateActiveMed.brandName} (${duplicateActiveMed.genericName} ${duplicateActiveMed.strength}).`}
                    </span>
                  </div>
                  <label className="flex items-center gap-2 font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={confirmDuplicateMed}
                      onChange={(e) => setConfirmDuplicateMed(e.target.checked)}
                      className="w-4 h-4 accent-[#103354]"
                    />
                    <span>
                      {isAr
                        ? 'أؤكد الحاجة لإضافة خطة منفصلة لهذا الدواء رغم وجود خطة نشطة'
                        : 'Confirm adding a separate plan despite matching active medication'}
                    </span>
                  </label>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
          <div>
            {step > 1 && (
              <button
                type="button"
                onClick={() => {
                  setStepErrors([]);
                  setStep((step - 1) as 1 | 2 | 3 | 4);
                }}
                className="px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 inline-flex items-center gap-1.5 min-h-[42px]"
              >
                {isAr ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
                <span>{t.common.previous}</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg min-h-[42px]"
            >
              {t.common.cancel}
            </button>
            {step < 4 ? (
              <button
                type="button"
                disabled={isWizardBlocked}
                onClick={handleNext}
                className="px-5 py-2.5 text-sm font-semibold text-white bg-[#103354] hover:bg-[#0B253E] disabled:opacity-50 rounded-lg inline-flex items-center gap-1.5 min-h-[42px]"
              >
                <span>{t.common.next}</span>
                {isAr ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            ) : (
              <button
                type="button"
                disabled={isSubmitting || isWizardBlocked}
                onClick={handleSave}
                className="px-5 py-2.5 text-sm font-semibold text-white bg-[#008C87] hover:bg-[#00736F] disabled:opacity-50 rounded-lg inline-flex items-center gap-1.5 min-h-[42px]"
              >
                <Check className="w-4 h-4" />
                <span>{isAr ? 'اعتماد وحفظ الخطة' : 'Confirm & Save Plan'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
