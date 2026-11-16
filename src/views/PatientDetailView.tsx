import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Edit3,
  FlaskConical,
  History,
  MessageSquare,
  PauseCircle,
  Phone,
  Pill,
  PlayCircle,
  Plus,
  Smartphone,
  StopCircle,
  X,
} from 'lucide-react';
import { DispenseModal } from '../components/modals/DispenseModal';
import { InvitationModal } from '../components/modals/InvitationModal';
import { MedicationWizardModal } from '../components/modals/MedicationWizardModal';
import { PatientFormModal } from '../components/modals/PatientFormModal';
import { useCrm } from '../context/CrmContext';
import {
  calculateAge,
  formatDate,
  formatDateTime,
  formatTimeDisplay,
  LABELS,
} from '../i18n/translations';
import { formatScheduleSummary } from '../services/scheduleEngine';
import { PatientMedicationPlan } from '../types/domain';

type ProfileTab =
  | 'overview'
  | 'medications'
  | 'dispensing_refills'
  | 'adherence'
  | 'labs'
  | 'followups_consults'
  | 'apk';

export const PatientDetailView: React.FC = () => {
  const {
    lang,
    use12Hour,
    selectedPatientId,
    navigateTo,
    state,
    isConnectedMode,
    todayStr,
    refillProjections,
    archivePatient,
    restorePatient,
    changeMedicationStatus,
    updateDoseEventStatus,
    addLabResult,
    pushToast,
  } = useCrm();

  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const patient = state.patients.find((p) => p.id === selectedPatientId);

  const [activeTab, setActiveTab] = useState<ProfileTab>('overview');
  const [showEditPatient, setShowEditPatient] = useState(false);
  const [showMedWizard, setShowMedWizard] = useState(false);
  const [editingPlan, setEditingPlan] = useState<PatientMedicationPlan | undefined>(undefined);
  const [historyPlan, setHistoryPlan] = useState<PatientMedicationPlan | null>(null);
  const [showDispenseModal, setShowDispenseModal] = useState(false);
  const [dispensePlanId, setDispensePlanId] = useState<string | undefined>(undefined);
  const [showInviteModal, setShowInviteModal] = useState(false);
  // Mandatory rule: Collapsible Refill Timeline & Adherence Pattern closed by default
  const [refillTimelineOpen, setRefillTimelineOpen] = useState(false);

  // Add Lab inline form state
  const [showAddLab, setShowAddLab] = useState(false);
  const [labTestName, setLabTestName] = useState('');
  const [labValue, setLabValue] = useState('');
  const [labUnit, setLabUnit] = useState('');
  const [labRefRange, setLabRefRange] = useState('');
  const [labAbnormal, setLabAbnormal] = useState(false);
  const [labDate, setLabDate] = useState(todayStr);
  const [isSubmittingLab, setIsSubmittingLab] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Reset per-patient transient UI state whenever pharmacist switches to another patient
  useEffect(() => {
    setActiveTab('overview');
    setRefillTimelineOpen(false);
    setHistoryPlan(null);
    setShowAddLab(false);
  }, [selectedPatientId]);

  useEffect(() => {
    if (!historyPlan) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setHistoryPlan(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [historyPlan]);

  const patientMeds = useMemo(() => {
    if (!patient) return { active: [], paused: [], history: [] };
    const all = state.medicationPlans
      .filter((m) => m.patientId === patient.id)
      // Newly added medication rows appear at the top
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      active: all.filter((m) => m.status === 'active'),
      paused: all.filter((m) => m.status === 'paused'),
      history: all.filter((m) => m.status === 'discontinued' || m.status === 'archived'),
    };
  }, [state.medicationPlans, patient]);

  const patientDispensing = useMemo(() => {
    if (!patient) return [];
    return state.dispensingEvents
      .filter((d) => d.patientId === patient.id)
      .sort((a, b) => b.dispensingDate.localeCompare(a.dispensingDate));
  }, [state.dispensingEvents, patient]);

  const patientRefills = useMemo(() => {
    if (!patient) return [];
    return refillProjections.filter((r) => r.patientId === patient.id);
  }, [refillProjections, patient]);

  const patientDoseEvents = useMemo(() => {
    if (!patient) return [];
    return state.doseEvents.filter((d) => d.patientId === patient.id);
  }, [state.doseEvents, patient]);

  const patientLabs = useMemo(() => {
    if (!patient) return [];
    return state.labResults
      .filter((l) => l.patientId === patient.id)
      .sort((a, b) => b.testDate.localeCompare(a.testDate));
  }, [state.labResults, patient]);

  const patientFollowUps = useMemo(() => {
    if (!patient) return [];
    return state.followUps.filter((f) => f.patientId === patient.id);
  }, [state.followUps, patient]);

  const patientConsults = useMemo(() => {
    if (!patient) return [];
    return state.consultations.filter((c) => c.patientId === patient.id);
  }, [state.consultations, patient]);

  const invitation = patient
    ? state.invitations.find((i) => i.patientId === patient.id)
    : undefined;

  if (!patient) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
        <p className="text-slate-600">
          {isAr ? 'لم يتم العثور على ملف المراجع.' : 'Patient record not found.'}
        </p>
        <button
          type="button"
          onClick={() => navigateTo('patients')}
          className="px-4 py-2 text-sm font-semibold text-white bg-[#103354] rounded-lg"
        >
          {isAr ? 'العودة إلى دليل المرضى' : 'Back to Patients'}
        </button>
      </div>
    );
  }

  const BackIcon = isAr ? ArrowRight : ArrowLeft;

  const handleSaveLab = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingLab) return;
    if (labTestName.trim().length < 2 || !labValue.trim()) {
      pushToast(
        isAr
          ? 'يرجى إدخال اسم التحليل (حرفين على الأقل) والنتيجة.'
          : 'Enter test name (at least 2 characters) and value.',
        'error'
      );
      return;
    }
    setIsSubmittingLab(true);
    try {
      await addLabResult({
        patientId: patient.id,
        testName: labTestName.trim(),
        value: labValue.trim(),
        unit: labUnit.trim(),
        referenceRange: labRefRange.trim() || '—',
        isAbnormal: labAbnormal,
        testDate: labDate,
      });
      setLabTestName('');
      setLabValue('');
      setLabUnit('');
      setLabRefRange('');
      setLabAbnormal(false);
      setShowAddLab(false);
      pushToast(isAr ? 'تم تسجيل نتيجة التحليل.' : 'Lab result recorded.');
    } catch (err) {
      pushToast(
        err instanceof Error
          ? err.message
          : isAr
            ? 'تعذر حفظ نتيجة التحليل.'
            : 'Unable to save lab result.',
        'error'
      );
    } finally {
      setIsSubmittingLab(false);
    }
  };

  const tabs: Array<{ id: ProfileTab; label: string }> = [
    { id: 'overview', label: isAr ? 'نظرة عامة' : 'Overview' },
    {
      id: 'medications',
      label: isAr
        ? `الأدوية (${patientMeds.active.length})`
        : `Medications (${patientMeds.active.length})`,
    },
    { id: 'dispensing_refills', label: isAr ? 'الصرف وإعادة الصرف' : 'Dispensing & Refills' },
    { id: 'adherence', label: isAr ? 'الالتزام والجدول اليومي' : 'Adherence & Schedule' },
    { id: 'labs', label: isAr ? `التحاليل (${patientLabs.length})` : `Labs (${patientLabs.length})` },
    {
      id: 'followups_consults',
      label: isAr ? 'المتابعات والاستشارات' : 'Follow-ups & Consults',
    },
    { id: 'apk', label: isAr ? 'تطبيق المريض (APK)' : 'Patient APK' },
  ];

  return (
    <div className="space-y-5">
      {/* Back button */}
      <div>
        <button
          type="button"
          onClick={() => navigateTo('patients')}
          className="text-xs font-semibold text-slate-600 hover:text-[#103354] inline-flex items-center gap-1.5"
        >
          <BackIcon className="w-4 h-4" />
          <span>{isAr ? 'العودة إلى سجل المرضى' : 'Back to Patient Directory'}</span>
        </button>
      </div>

      {/* Allergy Critical Clinical Alert */}
      {patient.allergies.length > 0 && (
        <div className="bg-[#FEF2F2] border border-[#A80000] rounded-[6px] p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-[#A80000] shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-bold text-[#A80000]">
              {isAr ? 'تنبيه حساسية دوائية مسجلة:' : 'Recorded Drug / Substance Allergies:'}
            </div>
            <div className="text-[#242424] text-xs mt-1 space-x-2 rtl:space-x-reverse">
              {patient.allergies.map((a, idx) => (
                <span key={a.id}>
                  {idx > 0 && ' · '}
                  <strong>{a.substance}</strong>
                  {a.reaction ? ` (${a.reaction})` : ''}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {patient.status === 'archived' && (
        <div
          role="status"
          className="bg-[#FFF4CE] border border-[#E0C878] rounded-[6px] p-3.5 text-xs text-[#242424] font-semibold"
        >
          {isAr
            ? 'هذا الملف مؤرشف للقراءة فقط: إضافة الخطط الدوائية وصرف الأدوية معطّلان حتى استعادة ملف المراجع.'
            : 'This patient profile is archived (read-only): adding medication plans and dispensing are disabled until the patient is restored.'}
        </div>
      )}

      {/* Patient Profile Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold text-[#103354]">{patient.fullName}</h2>
              {patient.status === 'archived' && (
                <span className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                  {t.common.archived}
                </span>
              )}
            </div>
            <div className="text-xs text-slate-600 flex flex-wrap items-center gap-2 tabular-nums">
              <span className="font-mono font-semibold text-[#103354]">{patient.patientCode}</span>
              <span aria-hidden="true">·</span>
              <span dir="ltr" className="font-mono">
                {patient.phone}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {calculateAge(patient.dateOfBirth, todayStr)} {t.common.years} (
                {patient.sex === 'female' ? (isAr ? 'أنثى' : 'Female') : isAr ? 'ذكر' : 'Male'})
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {isAr ? 'تاريخ التسجيل:' : 'Registered:'} {formatDate(patient.registrationDate, lang)}
              </span>
            </div>
            {patient.chronicConditions.length > 0 && (
              <div className="text-xs text-[#008C87] font-semibold pt-1">
                {patient.chronicConditions.join(isAr ? ' · ' : ' · ')}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={patient.status !== 'active'}
              onClick={() => {
                setEditingPlan(undefined);
                setShowMedWizard(true);
              }}
              className="px-3.5 py-2.5 text-xs font-semibold text-white bg-[#103354] hover:bg-[#0B253E] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg inline-flex items-center gap-1.5 min-h-[42px]"
            >
              <Plus className="w-4 h-4" />
              <span>{isAr ? 'إضافة علاج وجدولته' : 'Add & Schedule Medication'}</span>
            </button>
            <button
              type="button"
              disabled={patient.status !== 'active'}
              onClick={() => {
                setDispensePlanId(patientMeds.active[0]?.id);
                setShowDispenseModal(true);
              }}
              className="px-3.5 py-2.5 text-xs font-semibold text-white bg-[#008C87] hover:bg-[#00736F] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg inline-flex items-center gap-1.5 min-h-[42px]"
            >
              <Pill className="w-4 h-4" />
              <span>{isAr ? 'صرف علاج' : 'Dispense'}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowInviteModal(true)}
              className="px-3.5 py-2.5 text-xs font-semibold text-[#103354] bg-white border border-slate-300 hover:bg-slate-50 rounded-lg inline-flex items-center gap-1.5 min-h-[42px]"
            >
              <Smartphone className="w-4 h-4 text-[#008C87]" />
              <span>{isAr ? 'دعوة التطبيق' : 'APK Invite'}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowEditPatient(true)}
              className="p-2.5 text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 min-h-[42px] min-w-[42px] flex items-center justify-center"
              title={t.common.edit}
            >
              <Edit3 className="w-4 h-4" />
            </button>
            {patient.status === 'active' ? (
              <button
                type="button"
                disabled={busyAction === 'archive_restore'}
                onClick={async () => {
                  setBusyAction('archive_restore');
                  try {
                    await archivePatient(
                      patient.id,
                      isAr ? 'أرشفة من ملف المراجع' : 'Archived from profile'
                    );
                    pushToast(
                      isAr ? 'تمت أرشفة الملف مع حفظ التاريخ السريري.' : 'Patient archived.'
                    );
                  } catch (err) {
                    pushToast(
                      err instanceof Error
                        ? err.message
                        : isAr
                          ? 'تعذرت أرشفة الملف.'
                          : 'Unable to archive patient.',
                      'error'
                    );
                  } finally {
                    setBusyAction(null);
                  }
                }}
                className="p-2.5 text-slate-600 border border-slate-300 rounded-lg hover:bg-amber-50 hover:text-amber-800 disabled:opacity-50 min-h-[42px] min-w-[42px] flex items-center justify-center"
                title={isAr ? 'أرشفة الملف' : 'Archive patient'}
              >
                <Archive className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                disabled={busyAction === 'archive_restore'}
                onClick={async () => {
                  setBusyAction('archive_restore');
                  try {
                    await restorePatient(patient.id);
                    pushToast(isAr ? 'تمت استعادة ملف المراجع.' : 'Patient restored.');
                  } catch (err) {
                    pushToast(
                      err instanceof Error
                        ? err.message
                        : isAr
                          ? 'تعذرت استعادة الملف.'
                          : 'Unable to restore patient.',
                      'error'
                    );
                  } finally {
                    setBusyAction(null);
                  }
                }}
                className="p-2.5 text-[#008C87] border border-teal-300 rounded-lg hover:bg-teal-50 disabled:opacity-50 min-h-[42px] min-w-[42px] flex items-center justify-center"
                title={isAr ? 'استعادة الملف' : 'Restore patient'}
              >
                <ArchiveRestore className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Profile Tabs */}
        <div className="pt-3 border-t border-slate-200 flex items-center gap-1.5 overflow-x-auto pb-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-3.5 py-2 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 transition-colors min-h-[38px] ${
                activeTab === tab.id
                  ? 'bg-[#103354] text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-[#103354]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* TAB 1: OVERVIEW */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-7 space-y-5">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-[#103354]">
                  {isAr ? 'الأدوية النشطة حالياً' : 'Current Active Medications'}
                </h3>
                <button
                  type="button"
                  onClick={() => setActiveTab('medications')}
                  className="text-xs font-semibold text-[#008C87] hover:underline"
                >
                  {isAr ? 'إدارة الأدوية' : 'Manage Medications'}
                </button>
              </div>
              {patientMeds.active.length === 0 ? (
                <p className="text-sm text-slate-500 py-4">
                  {isAr ? 'لا توجد خطط دوائية نشطة حالياً.' : 'No active medications.'}
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {patientMeds.active.map((med) => (
                    <div key={med.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-bold text-[#103354]">
                          {med.brandName}{' '}
                          <span className="font-normal text-slate-600">
                            ({med.genericName} {med.strength})
                          </span>
                        </div>
                        <div className="text-xs text-slate-600 mt-0.5">
                          {formatScheduleSummary(med.schedule, med.doseUnit, lang, use12Hour)}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={patient.status !== 'active'}
                        onClick={() => {
                          setDispensePlanId(med.id);
                          setShowDispenseModal(true);
                        }}
                        className="px-3 py-1.5 text-xs font-semibold text-[#008C87] border border-teal-200 bg-teal-50/50 rounded-lg hover:bg-teal-50 disabled:opacity-50 disabled:cursor-not-allowed self-start sm:self-center whitespace-nowrap"
                      >
                        {isAr ? 'صرف الآن' : 'Dispense'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <h3 className="text-base font-bold text-[#103354]">
                {isAr ? 'الملاحظات السريرية وتفضيل التواصل' : 'Clinical Notes & Contact Preference'}
              </h3>
              <p className="text-sm text-slate-700 leading-relaxed">
                {patient.clinicalNotes || (isAr ? 'لا توجد ملاحظات مسجلة.' : 'No clinical notes.')}
              </p>
              <div className="text-xs text-slate-500 pt-2 border-t border-slate-100 flex flex-wrap gap-4">
                <span>
                  {isAr ? 'وسيلة التواصل:' : 'Preferred Contact:'}{' '}
                  <strong className="text-slate-800">{t.contactPref[patient.contactPreference]}</strong>
                </span>
                <span>
                  {isAr ? 'الصيدلية المسؤولة:' : 'Pharmacy:'}{' '}
                  <strong className="text-slate-800">
                    {isAr ? state.pharmacy.nameAr : state.pharmacy.nameEn}
                  </strong>
                </span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 space-y-5">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <h3 className="text-base font-bold text-[#103354]">
                {isAr ? 'توقعات إعادة الصرف' : 'Refill Projections'}
              </h3>
              {patientRefills.length === 0 ? (
                <p className="text-xs text-slate-500">
                  {isAr ? 'لا توجد توقعات نشطة.' : 'No active refill projections.'}
                </p>
              ) : (
                <div className="space-y-2.5">
                  {patientRefills.map((rf) => (
                    <div key={rf.medicationPlanId} className="p-3 bg-[#F5F7FA] border border-slate-200 rounded-lg text-xs space-y-1">
                      <div className="font-bold text-[#103354]">{rf.medicationLabel}</div>
                      <div className="flex items-center justify-between">
                        <span
                          className={`font-semibold ${
                            rf.refillStatus === 'overdue'
                              ? 'text-red-700'
                              : rf.refillStatus === 'due_soon'
                                ? 'text-amber-700'
                                : rf.refillStatus === 'unable_to_estimate' ||
                                    rf.refillStatus === 'paused_or_prn'
                                  ? 'text-slate-600'
                                  : 'text-[#008C87]'
                          }`}
                        >
                          {t.refillStatus[rf.refillStatus]}
                        </span>
                        <span className="tabular-nums font-semibold text-slate-700">
                          {rf.estimatedSupplyEndDate
                            ? formatDate(rf.estimatedSupplyEndDate, lang)
                            : t.refillStatus.unable_to_estimate}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500">{rf.uncertaintyNote}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2.5">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-[#103354]">
                  {isAr ? 'حالة تطبيق المريض (APK)' : 'Patient APK Account Status'}
                </h3>
                <button
                  type="button"
                  onClick={() => setShowInviteModal(true)}
                  className="text-xs font-semibold text-[#008C87] hover:underline"
                >
                  {isAr ? 'إدارة الدعوة' : 'Manage'}
                </button>
              </div>
              <div className="text-sm font-semibold text-slate-800">
                {t.invitationStatus[invitation?.status ?? 'not_invited']}
              </div>
              <p className="text-xs text-slate-500">
                {isConnectedMode
                  ? isAr
                    ? 'التفعيل محصور بالدعوات الصادرة من الصيدلي (تفعيل APK في الوضع المتصل معطل حتى المرحلة 2C).'
                    : 'Onboarding is strictly pharmacist-invited (Connected Mode APK activation disabled until Stage 2C).'
                  : isAr
                    ? 'التفعيل محصور بالدعوات الصادرة من الصيدلي (معاينة Stage 1 Mock).'
                    : 'Onboarding is strictly pharmacist-invited (Stage 1 Mock preview).'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: MEDICATIONS (Strictly separated Active / Paused / Discontinued) */}
      {activeTab === 'medications' && (
        <div className="space-y-6">
          {/* Active Medications */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-[#103354]">
                  {isAr ? 'الأدوية النشطة حالياً' : 'Active Medication Plans'}
                </h3>
                <p className="text-xs text-slate-500">
                  {isAr ? 'تظهر الأدوية المضافة حديثاً في الأعلى' : 'Newly added plans appear at the top'}
                </p>
              </div>
              <button
                type="button"
                disabled={patient.status !== 'active'}
                onClick={() => {
                  setEditingPlan(undefined);
                  setShowMedWizard(true);
                }}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-[#103354] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg inline-flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>{isAr ? 'إضافة دواء جديد' : 'Add Medication'}</span>
              </button>
            </div>

            {patientMeds.active.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {isAr ? 'لا توجد أدوية نشطة.' : 'No active medications.'}
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {patientMeds.active.map((med) => (
                  <div key={med.id} className="p-5 space-y-3">
                    <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-bold text-[#103354]">
                            {med.brandName} — {med.strength}
                          </span>
                          <span className="text-xs text-slate-500">
                            ({med.genericName}) · {t.dosageForms[med.dosageForm]} · v
                            {med.currentVersionNumber}
                          </span>
                        </div>
                        <div className="text-sm font-medium text-[#008C87]">
                          {formatScheduleSummary(med.schedule, med.doseUnit, lang, use12Hour)}
                        </div>
                        <p className="text-xs text-slate-700">{med.verifiedInstructions}</p>
                        <div className="text-[11px] text-slate-500 flex flex-wrap gap-3 pt-1">
                          <span>{t.foodRelations[med.foodRelation]}</span>
                          <span>·</span>
                          <span>
                            {isAr ? 'البداية:' : 'Start:'} {formatDate(med.startDate, lang)}
                          </span>
                          <span>·</span>
                          <span>
                            {med.isOngoing
                              ? isAr
                                ? 'علاج مستمر'
                                : 'Ongoing'
                              : `${isAr ? 'حتى' : 'Until'} ${formatDate(med.endDate, lang)}`}
                          </span>
                          {med.prescriberName && (
                            <>
                              <span>·</span>
                              <span>
                                {isAr ? 'الطبيب:' : 'Prescriber:'} {med.prescriberName}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={patient.status !== 'active'}
                          onClick={() => {
                            setDispensePlanId(med.id);
                            setShowDispenseModal(true);
                          }}
                          className="px-3 py-1.5 text-xs font-semibold text-white bg-[#008C87] hover:bg-[#00736F] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg"
                        >
                          {isAr ? 'صرف علاج' : 'Dispense'}
                        </button>
                        <button
                          type="button"
                          disabled={patient.status !== 'active'}
                          onClick={() => {
                            setEditingPlan(med);
                            setShowMedWizard(true);
                          }}
                          className="px-3 py-1.5 text-xs font-semibold text-[#103354] border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>{isAr ? 'تعديل الخطة' : 'Edit Plan'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setHistoryPlan(med)}
                          className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1"
                        >
                          <History className="w-3.5 h-3.5" />
                          <span>
                            {isAr
                              ? `النسخ (${med.regimenHistory.length})`
                              : `Versions (${med.regimenHistory.length})`}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={busyAction === `med:${med.id}`}
                          onClick={async () => {
                            setBusyAction(`med:${med.id}`);
                            try {
                              await changeMedicationStatus(
                                med.id,
                                'paused',
                                isAr ? 'إيقاف مؤقت بواسطة الصيدلي' : 'Paused by pharmacist'
                              );
                              pushToast(
                                isAr ? `تم إيقاف ${med.brandName} مؤقتاً.` : `${med.brandName} paused.`,
                                'warning'
                              );
                            } catch (err) {
                              pushToast(
                                err instanceof Error
                                  ? err.message
                                  : isAr
                                    ? 'تعذر تغيير حالة الدواء.'
                                    : 'Unable to update medication status.',
                                'error'
                              );
                            } finally {
                              setBusyAction(null);
                            }
                          }}
                          className="px-2.5 py-1.5 text-xs font-medium text-amber-800 border border-amber-200 bg-amber-50 rounded-lg hover:bg-amber-100 disabled:opacity-50 inline-flex items-center gap-1"
                        >
                          <PauseCircle className="w-3.5 h-3.5" />
                          <span>{isAr ? 'إيقاف مؤقت' : 'Pause'}</span>
                        </button>
                        <button
                          type="button"
                          disabled={busyAction === `med:${med.id}`}
                          onClick={async () => {
                            setBusyAction(`med:${med.id}`);
                            try {
                              await changeMedicationStatus(
                                med.id,
                                'discontinued',
                                isAr
                                  ? 'إيقاف نهائي مع حفظ التاريخ العلاجي'
                                  : 'Discontinued with history preserved'
                              );
                              pushToast(
                                isAr
                                  ? `تم نقل ${med.brandName} إلى سجل الأدوية الموقوفة.`
                                  : `${med.brandName} discontinued.`
                              );
                            } catch (err) {
                              pushToast(
                                err instanceof Error
                                  ? err.message
                                  : isAr
                                    ? 'تعذر إيقاف الدواء.'
                                    : 'Unable to discontinue medication.',
                                'error'
                              );
                            } finally {
                              setBusyAction(null);
                            }
                          }}
                          className="px-2.5 py-1.5 text-xs font-medium text-red-700 border border-red-200 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50 inline-flex items-center gap-1"
                        >
                          <StopCircle className="w-3.5 h-3.5" />
                          <span>{isAr ? 'إيقاف نهائي' : 'Discontinue'}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Paused Medications (Strictly Separated) */}
          {patientMeds.paused.length > 0 && (
            <div className="bg-white border border-amber-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 bg-amber-50/60 border-b border-amber-200">
                <h3 className="text-sm font-bold text-amber-900">
                  {isAr ? 'أدوية متوقفة مؤقتاً' : 'Paused Medications'}
                </h3>
              </div>
              <div className="divide-y divide-slate-100">
                {patientMeds.paused.map((med) => (
                  <div key={med.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-bold text-[#103354]">
                        {med.brandName} ({med.genericName} {med.strength})
                      </div>
                      <div className="text-xs text-amber-800 mt-0.5">
                        {med.statusChangeReason} · {formatDate(med.statusChangedAt, lang)}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busyAction === `med:${med.id}`}
                        onClick={async () => {
                          setBusyAction(`med:${med.id}`);
                          try {
                            await changeMedicationStatus(
                              med.id,
                              'active',
                              isAr ? 'استئناف العلاج' : 'Resumed'
                            );
                            pushToast(
                              isAr ? `تم استئناف ${med.brandName}.` : `${med.brandName} resumed.`
                            );
                          } catch (err) {
                            pushToast(
                              err instanceof Error
                                ? err.message
                                : isAr
                                  ? 'تعذر استئناف الخطة.'
                                  : 'Unable to resume medication.',
                              'error'
                            );
                          } finally {
                            setBusyAction(null);
                          }
                        }}
                        className="px-3 py-1.5 text-xs font-semibold text-[#008C87] border border-teal-200 bg-teal-50 rounded-lg disabled:opacity-50 inline-flex items-center gap-1"
                      >
                        <PlayCircle className="w-3.5 h-3.5" />
                        <span>{isAr ? 'استئناف' : 'Resume'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setHistoryPlan(med)}
                        className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg"
                      >
                        {isAr ? 'السجل' : 'History'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Discontinued / Archived History (Strictly Separated) */}
          {patientMeds.history.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200">
                <h3 className="text-sm font-bold text-slate-700">
                  {isAr ? 'سجل الأدوية الموقوفة والمؤرشفة' : 'Discontinued & Archived Medication History'}
                </h3>
              </div>
              <div className="divide-y divide-slate-100">
                {patientMeds.history.map((med) => (
                  <div key={med.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                    <div>
                      <div className="font-bold text-slate-800">
                        {med.brandName} ({med.genericName} {med.strength}) — {t.medStatus[med.status]}
                      </div>
                      <div className="text-slate-500 mt-0.5">
                        {formatDate(med.startDate, lang)} → {formatDate(med.statusChangedAt ?? med.endDate, lang)} ·{' '}
                        {med.statusChangeReason ?? med.verifiedInstructions}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setHistoryPlan(med)}
                      className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg self-start"
                    >
                      {isAr ? 'عرض النسخ' : 'View Versions'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: DISPENSING & REFILLS (with Collapsible Refill Timeline & Adherence Pattern closed by default) */}
      {activeTab === 'dispensing_refills' && (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-bold text-[#103354]">
                {isAr ? 'سجل عمليات الصرف وتوقعات النفاد' : 'Dispensing History & Supply Forecasts'}
              </h3>
              <button
                type="button"
                disabled={patient.status !== 'active'}
                onClick={() => {
                  setDispensePlanId(patientMeds.active[0]?.id);
                  setShowDispenseModal(true);
                }}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-[#008C87] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg inline-flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>{isAr ? 'صرف جديد' : 'New Dispense'}</span>
              </button>
            </div>

            {patientDispensing.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {isAr ? 'لم تُسجل عمليات صرف لهذا المراجع بعد.' : 'No dispensing events recorded yet.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-start">
                  <thead className="bg-[#F5F7FA] border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="py-3 px-4 text-start">{t.common.date}</th>
                      <th className="py-3 px-4 text-start">{isAr ? 'الدواء' : 'Medication'}</th>
                      <th className="py-3 px-4 text-start">{isAr ? 'الكمية المصروفة' : 'Qty Dispensed'}</th>
                      <th className="py-3 px-4 text-start">{isAr ? 'تقدير تاريخ النفاد' : 'Est. Supply End'}</th>
                      <th className="py-3 px-4 text-start">{isAr ? 'الصيدلي' : 'Staff'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {patientDispensing.map((evt) => {
                      const plan = state.medicationPlans.find((m) => m.id === evt.medicationPlanId);
                      return (
                        <tr key={evt.id}>
                          <td className="py-3 px-4 tabular-nums">{formatDate(evt.dispensingDate, lang)}</td>
                          <td className="py-3 px-4 font-semibold text-[#103354]">
                            {plan ? `${plan.brandName} ${plan.strength}` : evt.medicationPlanId}
                            {evt.isPartialFill && (
                              <span className="text-amber-700 font-normal ms-1.5">
                                ({isAr ? 'صرف جزئي' : 'Partial'})
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 tabular-nums font-bold">
                            {evt.dispensedQuantity} {evt.quantityUnit}
                          </td>
                          <td className="py-3 px-4 tabular-nums">
                            {evt.estimatedSupplyEndDate ? (
                              <div>
                                <span className="font-semibold text-[#008C87]">
                                  {formatDate(evt.estimatedSupplyEndDate, lang)}
                                </span>
                                <span className="text-slate-500 ms-1">
                                  ({evt.estimatedSupplyDays} {t.common.days})
                                </span>
                              </div>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="py-3 px-4 text-slate-600">{evt.dispensedByStaffName}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Mandatory Collapsible Section: CLOSED BY DEFAULT */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setRefillTimelineOpen((prev) => !prev)}
              className="w-full px-5 py-4 flex items-center justify-between text-start hover:bg-slate-50"
              aria-expanded={refillTimelineOpen}
            >
              <div className="flex items-center gap-2.5">
                <CalendarClock className="w-5 h-5 text-[#008C87]" />
                <div>
                  <div className="text-sm font-bold text-[#103354]">
                    {isAr
                      ? 'الخط الزمني لإعادة الصرف ونمط الالتزام (Refill Timeline & Adherence Pattern)'
                      : 'Refill Timeline & Adherence Pattern'}
                  </div>
                  <div className="text-xs text-slate-500">
                    {isAr
                      ? 'اضغط لعرض مقارنة فجوات الصرف مع تواريخ التغطية المتوقعة'
                      : 'Expand to inspect supply intervals vs. expected coverage dates'}
                  </div>
                </div>
              </div>
              {refillTimelineOpen ? (
                <ChevronUp className="w-5 h-5 text-slate-500" />
              ) : (
                <ChevronDown className="w-5 h-5 text-slate-500" />
              )}
            </button>

            {refillTimelineOpen && (
              <div className="px-5 pb-5 pt-2 border-t border-slate-200 space-y-3">
                {patientRefills.map((rf) => (
                  <div key={rf.medicationPlanId} className="p-3.5 bg-[#F5F7FA] border border-slate-200 rounded-lg text-xs space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[#103354]">{rf.medicationLabel}</span>
                      <span
                        className={`font-semibold ${
                          rf.refillStatus === 'overdue'
                            ? 'text-red-700'
                            : rf.refillStatus === 'due_soon'
                              ? 'text-amber-700'
                              : rf.refillStatus === 'unable_to_estimate' ||
                                  rf.refillStatus === 'paused_or_prn'
                                ? 'text-slate-600'
                                : 'text-[#008C87]'
                        }`}
                      >
                        {t.refillStatus[rf.refillStatus]}
                      </span>
                    </div>
                    <div className="text-slate-600">
                      {isAr ? 'آخر صرف:' : 'Last dispensed:'}{' '}
                      <span className="tabular-nums">
                        {rf.lastDispensedDate
                          ? formatDate(rf.lastDispensedDate, lang)
                          : isAr
                            ? 'لم يُصرف بعد'
                            : 'Not dispensed yet'}
                      </span>{' '}
                      · {isAr ? 'الرصيد المتبقي المقدر:' : 'Est. remaining:'}{' '}
                      <span className="tabular-nums font-bold">
                        {rf.estimatedRemainingUnits !== null
                          ? `${rf.estimatedRemainingUnits} ${rf.quantityUnit}`
                          : t.refillStatus.unable_to_estimate}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500">{rf.uncertaintyNote}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: ADHERENCE & DAILY SCHEDULE PREVIEW */}
      {activeTab === 'adherence' && (
        <div className="space-y-5">
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900">
            <strong>{isAr ? 'قاعدة السلامة الدوائية:' : 'Clinical Safety Rule:'}</strong>{' '}
            {isAr
              ? 'الجرعة غير المؤكدة من المراجع تبقى "بانتظار التأكيد" ولا تُسجل تلقائياً كـ "فائتة / متجاوزة". صرف الدواء من الصيدلية لا يُثبت تناول الجرعة.'
              : 'Unconfirmed doses remain Pending/Unconfirmed and are never automatically marked Skipped. Pharmacy dispensing does not prove dose ingestion.'}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-[#103354]">
                {isAr ? 'الجدول اليومي المتزامن مع تطبيق المريض' : 'Daily Dose Schedule & Confirmations'}
              </h3>
              <span className="text-xs text-slate-500">{t.common.baghdadTz}</span>
            </div>

            {patientMeds.active.length === 0 ? (
              <p className="text-sm text-slate-500">{t.common.noData}</p>
            ) : (
              <div className="space-y-3">
                {patientMeds.active.map((plan) =>
                  plan.schedule.doseSlots.length > 0 ? (
                    plan.schedule.doseSlots.map((slot) => {
                      const matchingEvent = patientDoseEvents.find(
                        (de) =>
                          de.medicationPlanId === plan.id &&
                          de.scheduledTime24 === slot.time24 &&
                          de.scheduledDate === todayStr
                      );
                      const status = matchingEvent?.status ?? 'pending_unconfirmed';
                      return (
                        <div
                          key={`${plan.id}-${slot.id}`}
                          className="p-4 border border-slate-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                        >
                          <div className="flex items-start gap-3">
                            <div className="px-2.5 py-1.5 bg-[#F5F7FA] border border-slate-200 rounded-lg text-xs font-mono font-bold text-[#103354] tabular-nums">
                              {formatTimeDisplay(slot.time24, use12Hour, lang)}
                            </div>
                            <div>
                              <div className="text-sm font-bold text-[#103354]">
                                {plan.brandName} ({plan.strength})
                              </div>
                              <div className="text-xs text-slate-600">
                                {slot.doseAmount} {plan.doseUnit} · {t.foodRelations[plan.foodRelation]}
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`text-xs font-semibold ${
                                status === 'taken'
                                  ? 'text-[#008C87]'
                                  : status === 'delayed'
                                    ? 'text-amber-700'
                                    : status === 'skipped_by_patient'
                                      ? 'text-red-700'
                                      : 'text-slate-500'
                              }`}
                            >
                              {t.doseConfirmStatus[status]}
                            </span>
                            {!isConnectedMode && matchingEvent && (
                              <button
                                type="button"
                                disabled={busyAction === `dose:${matchingEvent.id}`}
                                onClick={async () => {
                                  setBusyAction(`dose:${matchingEvent.id}`);
                                  try {
                                    await updateDoseEventStatus(
                                      matchingEvent.id,
                                      status === 'taken' ? 'pending_unconfirmed' : 'taken'
                                    );
                                  } catch (err) {
                                    pushToast(
                                      err instanceof Error
                                        ? err.message
                                        : isAr
                                          ? 'تعذر تحديث حالة الجرعة.'
                                          : 'Unable to update dose status.',
                                      'error'
                                    );
                                  } finally {
                                    setBusyAction(null);
                                  }
                                }}
                                className="px-2.5 py-1 text-[11px] font-semibold border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                              >
                                {status === 'taken'
                                  ? isAr
                                    ? 'إعادة لبانتظار التأكيد'
                                    : 'Reset to Unconfirmed'
                                  : isAr
                                    ? 'محاكاة تأكيد المريض'
                                    : 'Simulate Patient Confirm'}
                              </button>
                            )}
                            {isConnectedMode && matchingEvent && (
                              <span className="text-[11px] text-slate-500">
                                {isAr
                                  ? 'تأكيد المريض عبر تطبيق الأندرويد (بانتظار 2C)'
                                  : 'Patient APK confirmation (Stage 2C)'}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div key={plan.id} className="p-4 border border-slate-200 rounded-xl text-xs text-slate-600">
                      <strong className="text-[#103354]">{plan.brandName}:</strong>{' '}
                      {formatScheduleSummary(plan.schedule, plan.doseUnit, lang, use12Hour)}
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 5: LAB RESULTS */}
      {activeTab === 'labs' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-base font-bold text-[#103354]">
              {isAr ? 'نتائج التحاليل المختبرية' : 'Laboratory Results'}
            </h3>
            <button
              type="button"
              onClick={() => setShowAddLab((v) => !v)}
              className="px-3.5 py-2 text-xs font-semibold text-white bg-[#103354] rounded-lg inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>{isAr ? 'تسجيل نتيجة تحليل' : 'Add Lab Result'}</span>
            </button>
          </div>

          {showAddLab && (
            <form onSubmit={handleSaveLab} className="p-5 bg-[#F5F7FA] border-b border-slate-200 grid grid-cols-1 sm:grid-cols-6 gap-3">
              <input
                type="text"
                value={labTestName}
                onChange={(e) => setLabTestName(e.target.value)}
                placeholder={isAr ? 'اسم الفحص (مثل HbA1c)' : 'Test name (e.g. HbA1c)'}
                className="sm:col-span-2 px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
              />
              <input
                type="text"
                value={labValue}
                onChange={(e) => setLabValue(e.target.value)}
                placeholder={isAr ? 'القيمة' : 'Value'}
                className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg tabular-nums"
              />
              <input
                type="text"
                value={labUnit}
                onChange={(e) => setLabUnit(e.target.value)}
                placeholder={isAr ? 'الوحدة (%)' : 'Unit'}
                className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
              />
              <input
                type="text"
                value={labRefRange}
                onChange={(e) => setLabRefRange(e.target.value)}
                placeholder={isAr ? 'المدى المرجعي' : 'Ref range'}
                className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
              />
              <input
                type="date"
                value={labDate}
                onChange={(e) => setLabDate(e.target.value)}
                className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg tabular-nums"
              />
              <div className="sm:col-span-6 flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={labAbnormal}
                    onChange={(e) => setLabAbnormal(e.target.checked)}
                    className="w-4 h-4 accent-red-600"
                  />
                  <span>{isAr ? 'قيمة خارج النطاق المرجعي' : 'Outside reference range'}</span>
                </label>
                <button
                  type="submit"
                  disabled={isSubmittingLab}
                  className="px-4 py-2 text-xs font-semibold text-white bg-[#008C87] disabled:opacity-50 rounded-lg"
                >
                  {t.common.save}
                </button>
              </div>
            </form>
          )}

          {patientLabs.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              {isAr ? 'لا توجد تحاليل مسجلة.' : 'No lab results recorded.'}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {patientLabs.map((lab) => (
                <div key={lab.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-start gap-3">
                    <FlaskConical
                      className={`w-5 h-5 shrink-0 mt-0.5 ${
                        lab.isAbnormal ? 'text-red-600' : 'text-[#008C87]'
                      }`}
                    />
                    <div>
                      <div className="text-sm font-bold text-[#103354]">{lab.testName}</div>
                      <div className="text-xs text-slate-500">
                        {formatDate(lab.testDate, lang)} · {isAr ? 'المرجعي:' : 'Ref:'}{' '}
                        {lab.referenceRange}
                        {lab.notes ? ` · ${lab.notes}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="text-end">
                    <span
                      className={`text-base font-bold tabular-nums ${
                        lab.isAbnormal ? 'text-red-700' : 'text-[#103354]'
                      }`}
                    >
                      {lab.value} {lab.unit}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 6: FOLLOW-UPS & CONSULTATIONS */}
      {activeTab === 'followups_consults' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-[#103354]">
                {isAr ? 'مهام المتابعة السريرية' : 'Patient Follow-ups'}
              </h3>
              <button
                type="button"
                onClick={() => navigateTo('followups')}
                className="text-xs font-semibold text-[#008C87] hover:underline"
              >
                {isAr ? 'فتح مركز المتابعات' : 'Open Follow-ups'}
              </button>
            </div>
            {patientFollowUps.length === 0 ? (
              <p className="text-xs text-slate-500">{t.common.noData}</p>
            ) : (
              <div className="space-y-2.5">
                {patientFollowUps.map((fu) => (
                  <div key={fu.id} className="p-3 bg-[#F5F7FA] border border-slate-200 rounded-lg text-xs space-y-1">
                    <div className="flex justify-between font-bold text-[#103354]">
                      <span>{t.followUpTypes[fu.type]}</span>
                      <span className="tabular-nums">{formatDate(fu.dueDate, lang)}</span>
                    </div>
                    <p className="text-slate-600">{fu.notes}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="pt-2">
              <a
                href={`https://wa.me/964${patient.phone.replace(/^0/, '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3.5 py-2 text-xs font-semibold text-[#008C87] border border-teal-300 bg-teal-50/50 rounded-lg inline-flex items-center gap-1.5 hover:bg-teal-50"
              >
                <Phone className="w-3.5 h-3.5" />
                <span>
                  {isAr ? 'تواصل يدوي عبر واتساب (بدون إرسال تلقائي)' : 'Manual WhatsApp Contact'}
                </span>
              </a>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-[#103354]">
                {isAr ? 'الاستشارات الصيدلانية' : 'Consultations'}
              </h3>
              <button
                type="button"
                onClick={() => navigateTo('consultations')}
                className="text-xs font-semibold text-[#008C87] hover:underline"
              >
                {isAr ? 'فتح صندوق الاستشارات' : 'Open Inbox'}
              </button>
            </div>
            {patientConsults.length === 0 ? (
              <p className="text-xs text-slate-500">{t.common.noData}</p>
            ) : (
              <div className="space-y-2.5">
                {patientConsults.map((c) => (
                  <div key={c.id} className="p-3 bg-[#F5F7FA] border border-slate-200 rounded-lg text-xs space-y-1">
                    <div className="flex justify-between font-bold text-[#103354]">
                      <span className="flex items-center gap-1.5">
                        <MessageSquare className="w-3.5 h-3.5 text-[#008C87]" />
                        {c.subject}
                      </span>
                      <span>{t.consultationStatus[c.status]}</span>
                    </div>
                    <p className="text-slate-600">{c.messages[c.messages.length - 1]?.body}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 7: APK STATUS */}
      {activeTab === 'apk' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-bold text-[#103354]">
              {isAr ? 'ربط تطبيق المريض (MASAR Patient APK)' : 'Patient APK Onboarding Status'}
            </h3>
            <p className="text-sm font-semibold text-[#008C87]">
              {t.invitationStatus[invitation?.status ?? 'not_invited']}
            </p>
            <p className="text-xs text-slate-500">
              {isConnectedMode
                ? isAr
                  ? 'لا يوجد تسجيل ذاتي للمرضى. تفعيل وتوليد QR وSMS OTP في الوضع المتصل معطل حالياً حتى المرحلة 2C.'
                  : 'No self-registration exists. Connected Mode QR/SMS OTP onboarding is disabled until Stage 2C.'
                : isAr
                  ? 'لا يوجد تسجيل ذاتي للمرضى. يُصدر الصيدلي دعوة QR أو رابط تفعيل يتحقق من هوية المراجع.'
                  : 'No self-registration exists. Only authorized pharmacists issue QR/link invitations.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowInviteModal(true)}
            className="px-4 py-2.5 text-sm font-semibold text-white bg-[#103354] rounded-lg inline-flex items-center gap-2 shrink-0"
          >
            <Smartphone className="w-4 h-4" />
            <span>
              {isConnectedMode
                ? isAr
                  ? 'عرض حالة الدعوة (بانتظار 2C)'
                  : 'View Status (Stage 2C Pending)'
                : isAr
                  ? 'فتح إدارة الدعوة وQR'
                  : 'Open Invitation & QR'}
            </span>
          </button>
        </div>
      )}

      {/* Version History Drawer Modal */}
      {historyPlan && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="version-history-title"
        >
          <div className="bg-white w-full max-w-xl rounded-xl border border-slate-200 overflow-hidden max-h-[85vh] flex flex-col">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 id="version-history-title" className="text-base font-bold text-[#103354]">
                  {isAr ? 'سجل نسخ الخطة الدوائية' : 'Regimen Version History'} — {historyPlan.brandName}
                </h3>
                <p className="text-xs text-slate-500">
                  {historyPlan.genericName} {historyPlan.strength} ·{' '}
                  {isAr ? 'سجل تاريخي غير قابل للتعديل' : 'Immutable historical audit trail'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryPlan(null)}
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 min-h-[40px] min-w-[40px] flex items-center justify-center"
                aria-label={t.common.close}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto space-y-3">
              {[...historyPlan.regimenHistory].reverse().map((ver) => (
                <div key={ver.versionNumber} className="p-4 border border-slate-200 rounded-xl bg-[#F5F7FA] space-y-1.5 text-xs">
                  <div className="flex items-center justify-between font-bold text-[#103354]">
                    <span>
                      {isAr ? `النسخة رقم ${ver.versionNumber}` : `Version #${ver.versionNumber}`}
                    </span>
                    <span className="tabular-nums text-slate-500 font-normal">
                      {formatDate(ver.effectiveFrom, lang)} →{' '}
                      {ver.effectiveTo ? formatDate(ver.effectiveTo, lang) : isAr ? 'الحالية' : 'Current'}
                    </span>
                  </div>
                  <div className="font-semibold text-[#008C87]">
                    {formatScheduleSummary(ver.schedule, ver.doseUnit, lang, use12Hour)}
                  </div>
                  <p className="text-slate-700">{ver.verifiedInstructions}</p>
                  <div className="text-slate-500 pt-1">
                    {isAr ? 'السبب:' : 'Reason:'} {ver.changeReason} · {ver.changedByStaffName}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {showEditPatient && (
        <PatientFormModal
          isOpen={showEditPatient}
          onClose={() => setShowEditPatient(false)}
          existingPatient={patient}
        />
      )}
      {showMedWizard && (
        <MedicationWizardModal
          isOpen={showMedWizard}
          onClose={() => {
            setShowMedWizard(false);
            setEditingPlan(undefined);
          }}
          patient={patient}
          existingPlan={editingPlan}
        />
      )}
      {showDispenseModal && (
        <DispenseModal
          isOpen={showDispenseModal}
          onClose={() => setShowDispenseModal(false)}
          patient={patient}
          initialPlanId={dispensePlanId}
        />
      )}
      {showInviteModal && (
        <InvitationModal
          isOpen={showInviteModal}
          onClose={() => setShowInviteModal(false)}
          patient={patient}
        />
      )}
    </div>
  );
};
