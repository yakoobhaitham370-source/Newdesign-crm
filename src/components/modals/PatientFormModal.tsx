import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Plus, Trash2, X } from 'lucide-react';
import { useCrm } from '../../context/CrmContext';
import {
  calculateAge,
  isValidIraqiPhone,
  LABELS,
  normalizeIraqiPhone,
} from '../../i18n/translations';
import { findDuplicatePatientMatch } from '../../services/crmRepository';
import {
  AllergyDraftInput,
  getBilingualAllergyVerificationMessage,
  isAllergyPersistenceVerificationError,
  resolveAllergiesForSubmit,
  validateAndAddAllergyToList,
} from '../../services/patientAllergyHelpers';
import { ContactPreference, Patient, PatientAllergy, PatientSex } from '../../types/domain';

interface PatientFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  existingPatient?: Patient;
  onSaved?: (patient: Patient) => void;
}

const CHRONIC_PRESETS_AR = [
  'السكري النوع الثاني',
  'ارتفاع ضغط الدم',
  'ارتفاع الكوليسترول',
  'قصور الغدة الدرقية',
  'الربو المزمن',
  'الرجفان الأذيني',
  'أمراض الشرايين التاجية',
  'هشاشة العظام',
];

const CHRONIC_PRESETS_EN = [
  'Type 2 Diabetes',
  'Hypertension',
  'Dyslipidemia',
  'Hypothyroidism',
  'Chronic Asthma',
  'Atrial Fibrillation',
  'Coronary Artery Disease',
  'Osteoporosis',
];

export const PatientFormModal: React.FC<PatientFormModalProps> = ({
  isOpen,
  onClose,
  existingPatient,
  onSaved,
}) => {
  const { lang, state, isConnectedMode, todayStr, addPatient, updatePatient, pushToast } =
    useCrm();
  const isAr = lang === 'ar';
  const t = LABELS[lang];
  const lockImmutableFields = Boolean(isConnectedMode && existingPatient);

  const suggestedCode = `MC-${101 + state.patients.length}`;
  const initialAllergies = existingPatient?.allergies ?? [];

  const [patientCode, setPatientCode] = useState(existingPatient?.patientCode ?? suggestedCode);
  const [fullName, setFullName] = useState(existingPatient?.fullName ?? '');
  const [phone, setPhone] = useState(existingPatient?.phone ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(existingPatient?.dateOfBirth ?? '1975-01-01');
  const [sex, setSex] = useState<PatientSex>(existingPatient?.sex ?? 'female');
  const [chronicConditions, setChronicConditions] = useState<string[]>(
    existingPatient?.chronicConditions ?? []
  );
  const [customCondition, setCustomCondition] = useState('');
  const [allergies, setAllergies] = useState<PatientAllergy[]>(initialAllergies);
  const [newAllergySubstance, setNewAllergySubstance] = useState('');
  const [newAllergySeverity, setNewAllergySeverity] = useState<'mild' | 'moderate' | 'severe'>(
    'moderate'
  );
  const [newAllergyReaction, setNewAllergyReaction] = useState('');
  const [contactPreference, setContactPreference] = useState<ContactPreference>(
    existingPatient?.contactPreference ?? 'whatsapp'
  );
  const [clinicalNotes, setClinicalNotes] = useState(existingPatient?.clinicalNotes ?? '');
  const [registrationDate, setRegistrationDate] = useState(
    existingPatient?.registrationDate ?? todayStr
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const allergiesRef = useRef<PatientAllergy[]>(initialAllergies);
  const allergyDraftRef = useRef<AllergyDraftInput>({
    substance: '',
    severity: 'moderate',
    reaction: '',
  });
  const lastInitKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      lastInitKeyRef.current = null;
      return;
    }

    const initKey = existingPatient?.id ?? '__new__';
    if (lastInitKeyRef.current === initKey) {
      return;
    }
    lastInitKeyRef.current = initKey;

    const resetAllergies = (existingPatient?.allergies ?? []).map((a) => ({ ...a }));
    setPatientCode(existingPatient?.patientCode ?? `MC-${101 + state.patients.length}`);
    setFullName(existingPatient?.fullName ?? '');
    setPhone(existingPatient?.phone ?? '');
    setDateOfBirth(existingPatient?.dateOfBirth ?? '1975-01-01');
    setSex(existingPatient?.sex ?? 'female');
    setChronicConditions([...(existingPatient?.chronicConditions ?? [])]);
    setCustomCondition('');
    setAllergies(resetAllergies);
    allergiesRef.current = resetAllergies;
    setNewAllergySubstance('');
    setNewAllergySeverity('moderate');
    setNewAllergyReaction('');
    allergyDraftRef.current = {
      substance: '',
      severity: 'moderate',
      reaction: '',
    };
    setContactPreference(existingPatient?.contactPreference ?? 'whatsapp');
    setClinicalNotes(existingPatient?.clinicalNotes ?? '');
    setRegistrationDate(existingPatient?.registrationDate ?? todayStr);
    setErrors([]);
    setDuplicateWarning(null);
    setConfirmDuplicate(false);
    setIsSubmitting(false);
  }, [isOpen, existingPatient, todayStr, state.patients.length]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const presets = isAr ? CHRONIC_PRESETS_AR : CHRONIC_PRESETS_EN;

  const toggleCondition = (cond: string) => {
    setChronicConditions((prev) =>
      prev.includes(cond) ? prev.filter((c) => c !== cond) : [...prev, cond]
    );
  };

  const handleAddCustomCondition = () => {
    const trimmed = customCondition.trim();
    if (!trimmed) return;
    if (trimmed.length < 2) {
      pushToast(
        isAr
          ? 'اسم الحالة المزمنة يجب أن يكون حرفين على الأقل.'
          : 'Condition name must be at least 2 characters.',
        'error'
      );
      return;
    }
    if (!chronicConditions.includes(trimmed)) {
      setChronicConditions((prev) => [...prev, trimmed]);
    }
    setCustomCondition('');
  };

  const handleRemoveAllergy = (allergyId: string) => {
    const next = allergiesRef.current.filter((a) => a.id !== allergyId);
    allergiesRef.current = next;
    setAllergies(next);
  };

  const handleAddAllergy = () => {
    const draft = allergyDraftRef.current;
    if (!draft.substance.trim() && !draft.reaction.trim()) return;

    const result = validateAndAddAllergyToList(allergiesRef.current, draft, lang);
    if (!result.ok) {
      setErrors((prev) => (prev.includes(result.error) ? prev : [...prev, result.error]));
      pushToast(result.error, 'error');
      return;
    }

    allergiesRef.current = result.allergies;
    setAllergies(result.allergies);
    allergyDraftRef.current = {
      substance: '',
      severity: 'moderate',
      reaction: '',
    };
    setNewAllergySubstance('');
    setNewAllergySeverity('moderate');
    setNewAllergyReaction('');
    setErrors([]);
  };

  const validateAndSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    const errs: string[] = [];

    const effectivePatientCode = lockImmutableFields
      ? existingPatient!.patientCode
      : patientCode.trim();
    const effectiveRegistrationDate = lockImmutableFields
      ? existingPatient!.registrationDate
      : registrationDate;

    if (!effectivePatientCode) {
      errs.push(isAr ? 'رمز المراجع مطلوب.' : 'Patient ID code is required.');
    } else if (effectivePatientCode.length < 3) {
      errs.push(
        isAr
          ? 'رمز المراجع يجب أن يكون ٣ أحرف على الأقل.'
          : 'Patient ID code must be at least 3 characters.'
      );
    }
    if (fullName.trim().length < 3) {
      errs.push(
        isAr ? 'الاسم الكامل يجب أن يكون ٣ أحرف على الأقل.' : 'Full name must be at least 3 characters.'
      );
    }
    const normalizedPhone = normalizeIraqiPhone(phone);
    if (!isValidIraqiPhone(phone)) {
      errs.push(
        isAr
          ? 'يرجى إدخال رقم هاتف عراقي صحيح (07XXXXXXXXX أو +9647XXXXXXXXX).'
          : 'Please enter a valid Iraqi mobile number (07XXXXXXXXX or +9647XXXXXXXXX).'
      );
    }
    if (!dateOfBirth) {
      errs.push(isAr ? 'تاريخ الميلاد مطلوب.' : 'Date of birth is required.');
    } else if (dateOfBirth > todayStr) {
      errs.push(
        isAr ? 'تاريخ الميلاد لا يمكن أن يكون في المستقبل.' : 'Date of birth cannot be in the future.'
      );
    }
    if (!effectiveRegistrationDate) {
      errs.push(isAr ? 'تاريخ التسجيل مطلوب.' : 'Registration date is required.');
    }

    const dupMatch = findDuplicatePatientMatch(
      state.patients,
      {
        patientCode: effectivePatientCode,
        phone: normalizedPhone,
        fullName,
        dateOfBirth,
      },
      existingPatient?.id
    );

    if (dupMatch.codeConflict) {
      errs.push(
        isAr
          ? `رمز المراجع (${effectivePatientCode}) مستخدم بالفعل للمراجع ${dupMatch.codeConflict.fullName}.`
          : `Patient ID code (${effectivePatientCode}) already exists for ${dupMatch.codeConflict.fullName}.`
      );
    }

    const allergyResolution = resolveAllergiesForSubmit(
      allergiesRef.current,
      allergyDraftRef.current,
      lang
    );
    if (!allergyResolution.ok) {
      errs.push(allergyResolution.error);
    }

    if (errs.length > 0 || !allergyResolution.ok) {
      setErrors(errs);
      return;
    }

    const resolvedAllergies = allergyResolution.allergies;

    const warnings: string[] = [];
    if (dupMatch.phoneConflict) {
      warnings.push(
        isAr
          ? `رقم الهاتف (${normalizedPhone}) مسجل مسبقاً للمراجع "${dupMatch.phoneConflict.fullName}" (${dupMatch.phoneConflict.patientCode}).`
          : `Phone (${normalizedPhone}) is already registered for "${dupMatch.phoneConflict.fullName}" (${dupMatch.phoneConflict.patientCode}).`
      );
    }
    if (dupMatch.nameDobConflict) {
      warnings.push(
        isAr
          ? `يوجد ملف مطابق لنفس الاسم وتاريخ الميلاد ("${dupMatch.nameDobConflict.fullName}" · ${dupMatch.nameDobConflict.patientCode}).`
          : `A matching name and date of birth already exists ("${dupMatch.nameDobConflict.fullName}" · ${dupMatch.nameDobConflict.patientCode}).`
      );
    }

    if (warnings.length > 0 && !confirmDuplicate) {
      setErrors([]);
      setDuplicateWarning(warnings.join(' '));
      return;
    }

    setErrors([]);
    setDuplicateWarning(null);
    setIsSubmitting(true);

    try {
      if (existingPatient) {
        const updatedFields = {
          patientCode: effectivePatientCode,
          fullName: fullName.trim(),
          phone: normalizedPhone,
          dateOfBirth,
          sex,
          chronicConditions,
          allergies: resolvedAllergies,
          contactPreference,
          clinicalNotes: clinicalNotes.trim(),
          registrationDate: effectiveRegistrationDate,
        };
        await updatePatient(existingPatient.id, updatedFields);
        allergiesRef.current = resolvedAllergies;
        setAllergies(resolvedAllergies);
        allergyDraftRef.current = { substance: '', severity: 'moderate', reaction: '' };
        setNewAllergySubstance('');
        setNewAllergySeverity('moderate');
        setNewAllergyReaction('');
        pushToast(isAr ? 'تم تحديث ملف المراجع بنجاح.' : 'Patient profile updated.');
        onSaved?.({ ...existingPatient, ...updatedFields });
        onClose();
      } else {
        const created = await addPatient({
          patientCode: effectivePatientCode,
          fullName: fullName.trim(),
          phone: normalizedPhone,
          dateOfBirth,
          sex,
          chronicConditions,
          allergies: resolvedAllergies,
          contactPreference,
          clinicalNotes: clinicalNotes.trim(),
          registrationDate: effectiveRegistrationDate,
        });
        allergiesRef.current = created.allergies;
        setAllergies(created.allergies);
        allergyDraftRef.current = { substance: '', severity: 'moderate', reaction: '' };
        setNewAllergySubstance('');
        setNewAllergySeverity('moderate');
        setNewAllergyReaction('');
        pushToast(
          isAr
            ? `تم تسجيل المراجع ${created.fullName} بنجاح.`
            : `Patient ${created.fullName} registered.`
        );
        onSaved?.(created);
        onClose();
      }
    } catch (err) {
      const msg = isAllergyPersistenceVerificationError(err)
        ? getBilingualAllergyVerificationMessage(lang)
        : err instanceof Error
          ? err.message
          : isAr
            ? 'تعذر حفظ بيانات المراجع.'
            : 'Unable to save patient record.';
      setErrors([msg]);
      pushToast(msg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="patient-modal-title"
    >
      <div className="bg-white w-full h-full sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-xl border border-slate-200 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-white">
          <div>
            <h2 id="patient-modal-title" className="text-lg font-bold text-[#103354]">
              {existingPatient
                ? isAr
                  ? 'تعديل بيانات المراجع'
                  : 'Edit Patient Record'
                : isAr
                  ? 'تسجيل مراجع جديد (بواسطة الصيدلي)'
                  : 'Register New Patient (Pharmacist-Only)'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {isAr ? state.pharmacy.nameAr : state.pharmacy.nameEn} ·{' '}
              {isAr ? 'الصلاحية مقتصرة على كادر الصيدلية' : 'Authorized pharmacy staff only'}
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

        <form onSubmit={validateAndSubmit} className="flex-1 overflow-y-auto p-5 space-y-5">
          {duplicateWarning && (
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-3.5 text-xs text-amber-950 space-y-2">
              <div className="flex items-start gap-2 font-semibold">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <span>
                  {isAr ? 'تحذير احتمال تكرار ملف مراجع:' : 'Possible Duplicate Patient Warning:'}
                </span>
              </div>
              <p>{duplicateWarning}</p>
              <label className="flex items-center gap-2 font-semibold cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={confirmDuplicate}
                  onChange={(e) => setConfirmDuplicate(e.target.checked)}
                  className="w-4 h-4 accent-[#103354]"
                />
                <span>
                  {isAr
                    ? 'أؤكد أن هذا مراجع مستقل (أو رقم هاتف مشترك لعائلة) وأرغب في المتابعة'
                    : 'I confirm this is a distinct patient and wish to proceed'}
                </span>
              </label>
            </div>
          )}

          {errors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 space-y-1">
              <div className="flex items-center gap-2 font-semibold">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{isAr ? 'يرجى تصحيح الحقول التالية:' : 'Please fix the following:'}</span>
              </div>
              <ul className="list-disc list-inside text-xs space-y-0.5">
                {errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                {isAr ? 'رمز المراجع (Patient ID) *' : 'Patient ID *'}
              </label>
              <input
                type="text"
                disabled={lockImmutableFields}
                value={lockImmutableFields ? existingPatient!.patientCode : patientCode}
                onChange={(e) => setPatientCode(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg font-mono tabular-nums focus:border-[#008C87] focus:outline-none disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed"
                placeholder="MC-107"
              />
              {lockImmutableFields && (
                <p className="text-[11px] text-slate-500 mt-1">
                  {isAr
                    ? 'ثابت بعد الإنشاء في الوضع المتصل.'
                    : 'Immutable after creation in Connected Mode.'}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                {isAr ? 'تاريخ التسجيل *' : 'Registration Date *'}
              </label>
              <input
                type="date"
                disabled={lockImmutableFields}
                value={lockImmutableFields ? existingPatient!.registrationDate : registrationDate}
                onChange={(e) => setRegistrationDate(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg tabular-nums focus:border-[#008C87] focus:outline-none disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                {isAr ? 'الاسم الكامل للمراجع *' : 'Full Name *'}
              </label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => {
                  setFullName(e.target.value);
                  setConfirmDuplicate(false);
                  setDuplicateWarning(null);
                }}
                className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:border-[#008C87] focus:outline-none"
                placeholder={isAr ? 'مثال: سعاد حسن الجبوري' : 'e.g. Suad Hassan Al-Jubouri'}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                {isAr ? 'رقم الهاتف العراقي *' : 'Iraqi Phone Number *'}
              </label>
              <input
                type="tel"
                dir="ltr"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setConfirmDuplicate(false);
                  setDuplicateWarning(null);
                }}
                className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg font-mono tabular-nums focus:border-[#008C87] focus:outline-none"
                placeholder="07701234567"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                {isAr ? 'تاريخ الميلاد *' : 'Date of Birth *'}{' '}
                {dateOfBirth && (
                  <span className="text-slate-500 font-normal">
                    ({calculateAge(dateOfBirth, todayStr)} {t.common.years})
                  </span>
                )}
              </label>
              <input
                type="date"
                value={dateOfBirth}
                onChange={(e) => {
                  setDateOfBirth(e.target.value);
                  setConfirmDuplicate(false);
                  setDuplicateWarning(null);
                }}
                className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg tabular-nums focus:border-[#008C87] focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                {isAr ? 'الجنس *' : 'Sex *'}
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(['female', 'male'] as PatientSex[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSex(s)}
                    className={`py-2.5 px-3 text-sm font-medium rounded-lg border transition-colors min-h-[42px] ${
                      sex === s
                        ? 'bg-[#103354] text-white border-[#103354]'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {s === 'female' ? (isAr ? 'أنثى' : 'Female') : isAr ? 'ذكر' : 'Male'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                {isAr ? 'وسيلة التواصل المفضلة' : 'Contact Preference'}
              </label>
              <select
                value={contactPreference}
                onChange={(e) => setContactPreference(e.target.value as ContactPreference)}
                className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg bg-white focus:border-[#008C87] focus:outline-none"
              >
                <option value="whatsapp">{t.contactPref.whatsapp}</option>
                <option value="phone_call">{t.contactPref.phone_call}</option>
                <option value="apk_notification">{t.contactPref.apk_notification}</option>
              </select>
            </div>
          </div>

          {/* Chronic Conditions */}
          <div className="pt-2 border-t border-slate-200">
            <label className="block text-xs font-semibold text-slate-700 mb-2">
              {isAr ? 'الأمراض المزمنة' : 'Chronic Conditions'}
            </label>
            <div className="flex flex-wrap gap-2 mb-3">
              {presets.map((cond) => {
                const selected = chronicConditions.includes(cond);
                return (
                  <button
                    key={cond}
                    type="button"
                    onClick={() => toggleCondition(cond)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors min-h-[36px] ${
                      selected
                        ? 'bg-[#008C87] text-white border-[#008C87]'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {cond}
                  </button>
                );
              })}
            </div>
            {chronicConditions.filter((c) => !presets.includes(c)).length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {chronicConditions
                  .filter((c) => !presets.includes(c))
                  .map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggleCondition(c)}
                      className="px-3 py-1 text-xs font-medium rounded-lg bg-[#103354] text-white flex items-center gap-1.5"
                    >
                      <span>{c}</span>
                      <X className="w-3 h-3" />
                    </button>
                  ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={customCondition}
                onChange={(e) => setCustomCondition(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddCustomCondition();
                  }
                }}
                placeholder={isAr ? 'إضافة حالة مزمنة أخرى...' : 'Add another chronic condition...'}
                className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:border-[#008C87] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddCustomCondition}
                className="px-3 py-2 text-xs font-semibold bg-slate-100 text-slate-800 rounded-lg border border-slate-300 hover:bg-slate-200 flex items-center gap-1"
              >
                <Plus className="w-4 h-4" />
                <span>{t.common.add}</span>
              </button>
            </div>
          </div>

          {/* Allergies */}
          <div className="pt-2 border-t border-slate-200">
            <label className="block text-xs font-semibold text-slate-700 mb-2">
              {isAr ? 'الحساسية الدوائية والغذائية' : 'Drug & Substance Allergies'}
            </label>
            {allergies.length > 0 && (
              <div className="space-y-2 mb-3">
                {allergies.map((alg) => (
                  <div
                    key={alg.id}
                    className="flex items-center justify-between px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs"
                  >
                    <div>
                      <span className="font-semibold text-red-900">{alg.substance}</span>
                      <span className="text-red-700 mx-2">·</span>
                      <span className="text-red-700">
                        {alg.severity === 'severe'
                          ? isAr
                            ? 'شديدة'
                            : 'Severe'
                          : alg.severity === 'moderate'
                            ? isAr
                              ? 'متوسطة'
                              : 'Moderate'
                            : isAr
                              ? 'خفيفة'
                              : 'Mild'}
                      </span>
                      {alg.reaction && <span className="text-red-700"> — {alg.reaction}</span>}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveAllergy(alg.id)}
                      className="p-1.5 text-red-700 hover:bg-red-100 rounded"
                      aria-label="Remove allergy"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
              <input
                type="text"
                value={newAllergySubstance}
                onChange={(e) => {
                  const val = e.target.value;
                  allergyDraftRef.current = { ...allergyDraftRef.current, substance: val };
                  setNewAllergySubstance(val);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddAllergy();
                  }
                }}
                placeholder={isAr ? 'المادة المسببة للحساسية (مثل: Penicillin)' : 'Substance (e.g. Penicillin)'}
                className="sm:col-span-5 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:border-[#008C87] focus:outline-none"
              />
              <select
                value={newAllergySeverity}
                onChange={(e) => {
                  const val = e.target.value as 'mild' | 'moderate' | 'severe';
                  allergyDraftRef.current = { ...allergyDraftRef.current, severity: val };
                  setNewAllergySeverity(val);
                }}
                className="sm:col-span-3 px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="mild">{isAr ? 'خفيفة' : 'Mild'}</option>
                <option value="moderate">{isAr ? 'متوسطة' : 'Moderate'}</option>
                <option value="severe">{isAr ? 'شديدة' : 'Severe'}</option>
              </select>
              <input
                type="text"
                value={newAllergyReaction}
                onChange={(e) => {
                  const val = e.target.value;
                  allergyDraftRef.current = { ...allergyDraftRef.current, reaction: val };
                  setNewAllergyReaction(val);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddAllergy();
                  }
                }}
                placeholder={isAr ? 'التفاعل (اختياري)' : 'Reaction (optional)'}
                className="sm:col-span-4 px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={handleAddAllergy}
                className="px-3 py-1.5 text-xs font-semibold text-[#103354] bg-slate-100 hover:bg-slate-200 rounded-lg border border-slate-200 inline-flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{isAr ? 'إضافة حساسية للقائمة' : 'Add Allergy'}</span>
              </button>
              <p className="text-[11px] text-slate-500">
                {isAr
                  ? 'يمكنك الضغط على إضافة أو الحفظ مباشرة؛ يتم تضمين الإدخال المكتمل تلقائياً.'
                  : 'Click Add Allergy for multiple entries, or save directly—complete entries are included automatically.'}
              </p>
            </div>
          </div>

          {/* Clinical Notes */}
          <div className="pt-2 border-t border-slate-200">
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              {isAr ? 'ملاحظات سريرية ذات صلة' : 'Relevant Clinical Notes'}
            </label>
            <textarea
              rows={3}
              value={clinicalNotes}
              onChange={(e) => setClinicalNotes(e.target.value)}
              placeholder={
                isAr
                  ? 'ملاحظات عن المتابعة أو اعتبارات الجرعات...'
                  : 'Follow-up notes, clinical considerations...'
              }
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:border-[#008C87] focus:outline-none"
            />
          </div>
        </form>

        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 min-h-[42px]"
          >
            {t.common.cancel}
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={validateAndSubmit}
            className="px-5 py-2.5 text-sm font-semibold text-white bg-[#103354] hover:bg-[#0B253E] disabled:opacity-50 rounded-lg min-h-[42px]"
          >
            {existingPatient
              ? isAr
                ? 'حفظ التعديلات'
                : 'Save Changes'
              : isAr
                ? 'تسجيل المراجع'
                : 'Register Patient'}
          </button>
        </div>
      </div>
    </div>
  );
};
