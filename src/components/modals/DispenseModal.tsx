import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertOctagon, AlertTriangle, Calendar, Info, Package, RefreshCw, X } from 'lucide-react';
import { useCrm } from '../../context/CrmContext';
import { formatDate, LABELS } from '../../i18n/translations';
import {
  assessMedicationAllergyRisk,
  classifyUncertainNetworkError,
  computeDispensingPayloadHash,
  DispensingRefillSnapshotInput,
  toAllergyOverrideLevel,
  validateAllergyOverrideAuthorization,
  validateDispensingInput,
} from '../../services/clinicalSafety';
import { findRecentDuplicateDispensing } from '../../services/crmRepository';
import {
  buildDispensingIdempotencyScopeKey,
  clearPendingDispensingUuid,
  getOrCreatePendingDispensingUuid,
  getPendingDispensingUuids,
} from '../../services/dispensingIdempotencyStore';
import {
  calculateDispensingForecast,
  computeRefillProjection,
  formatScheduleSummary,
} from '../../services/scheduleEngine';
import { AllergySafetyBanner } from '../common/AllergySafetyBanner';
import {
  AllergyOverrideAuthorization,
  DispensingEvent,
  Patient,
  PatientMedicationPlan,
} from '../../types/domain';

interface DispenseModalProps {
  isOpen: boolean;
  onClose: () => void;
  patient: Patient;
  initialPlanId?: string;
}

export const DispenseModal: React.FC<DispenseModalProps> = ({
  isOpen,
  onClose,
  patient,
  initialPlanId,
}) => {
  const {
    lang,
    use12Hour,
    state,
    todayStr,
    authenticatedPharmacist,
    backendCapabilities,
    recordDispensing,
    refreshState,
    refreshBackendCapabilities,
    pushToast,
  } = useCrm();
  const activeUserId = authenticatedPharmacist?.userId ?? state.activeStaffId;
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const isPatientArchived = patient.status !== 'active';

  const activePlans = useMemo(
    () =>
      state.medicationPlans.filter(
        (m) => m.patientId === patient.id && m.status === 'active'
      ),
    [state.medicationPlans, patient.id]
  );

  const [selectedPlanId, setSelectedPlanId] = useState<string>(
    initialPlanId ?? activePlans[0]?.id ?? ''
  );
  const selectedPlan: PatientMedicationPlan | undefined =
    activePlans.find((m) => m.id === selectedPlanId) ?? activePlans[0];

  const [packageCount, setPackageCount] = useState<number>(1);
  const [packageSize, setPackageSize] = useState<number>(30);
  const [dispensedQuantity, setDispensedQuantity] = useState<number>(30);
  const [dispensingDate, setDispensingDate] = useState<string>(todayStr);
  const prevTodayRef = useRef<string>(todayStr);

  useEffect(() => {
    if (dispensingDate === prevTodayRef.current) {
      setDispensingDate(todayStr);
    }
    prevTodayRef.current = todayStr;
  }, [todayStr, dispensingDate]);

  const [batchNumber, setBatchNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [isPartialFill, setIsPartialFill] = useState(false);
  const [planConfirmed, setPlanConfirmed] = useState(true);
  const [notes, setNotes] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uncertainNetworkMsg, setUncertainNetworkMsg] = useState<string | null>(null);
  const [isRefreshingLedger, setIsRefreshingLedger] = useState(false);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [allergyOverride, setAllergyOverride] = useState<AllergyOverrideAuthorization>({
    acknowledged: false,
    authorizationSource: 'prescriber_written_order',
  });
  const [commitSeq, setCommitSeq] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLockRef = useRef(false);

  const selectedPlanIdActual = selectedPlan?.id ?? '';
  useEffect(() => {
    setAllergyOverride({
      acknowledged: false,
      authorizationSource: 'prescriber_written_order',
    });
  }, [selectedPlanIdActual]);

  const allergyAssessment = useMemo(() => {
    if (!selectedPlan) return null;
    return assessMedicationAllergyRisk(
      patient,
      {
        catalogId: selectedPlan.catalogId,
        brandName: selectedPlan.brandName,
        genericName: selectedPlan.genericName,
        strength: selectedPlan.strength,
      },
      lang
    );
  }, [patient, selectedPlan, lang]);

  const normalizedOverrideAuth = useMemo<AllergyOverrideAuthorization | undefined>(() => {
    if (!allergyAssessment?.requiresPharmacistAcknowledgment) return undefined;
    return {
      ...allergyOverride,
      level: toAllergyOverrideLevel(allergyAssessment.level),
    };
  }, [allergyAssessment, allergyOverride]);

  const pendingDispensingUuids = useMemo(() => {
    void commitSeq;
    return getPendingDispensingUuids();
  }, [commitSeq, state.dispensingEvents.length]);

  const priorEventsWithoutPending = useMemo(
    () =>
      state.dispensingEvents.filter(
        (d) => !d.clientEventUuid || !pendingDispensingUuids.has(d.clientEventUuid)
      ),
    [state.dispensingEvents, pendingDispensingUuids]
  );

  const forecast = useMemo(
    () =>
      selectedPlan
        ? calculateDispensingForecast(selectedPlan, dispensedQuantity, dispensingDate, lang)
        : null,
    [selectedPlan, dispensedQuantity, dispensingDate, lang]
  );

  const refillSnapshot = useMemo<DispensingRefillSnapshotInput | undefined>(() => {
    if (!selectedPlan || !forecast) return undefined;
    const qtyValid = Number.isFinite(dispensedQuantity) && dispensedQuantity > 0;
    const refDateStr = dispensingDate > todayStr ? dispensingDate : todayStr;
    const staff = state.staff.find((s) => s.id === state.activeStaffId);
    const syntheticPendingEvent: DispensingEvent = {
      id: 'pending-fill',
      pharmacyId: state.pharmacy.id,
      patientId: patient.id,
      medicationPlanId: selectedPlan.id,
      regimenVersionNumber: selectedPlan.currentVersionNumber,
      dispensedQuantity: qtyValid ? dispensedQuantity : 0,
      quantityUnit: selectedPlan.doseUnit,
      packageCount: packageCount > 0 ? packageCount : undefined,
      packageSize: packageSize > 0 ? packageSize : undefined,
      batchNumber: batchNumber.trim() || undefined,
      expiryDate: expiryDate || undefined,
      dispensingDate,
      dispensedByStaffId: activeUserId,
      dispensedByStaffName: staff?.fullName ?? '',
      notes: notes.trim() || undefined,
      estimatedDailyConsumption: forecast.estimatedDailyConsumption,
      estimatedSupplyDays: forecast.estimatedSupplyDays,
      estimatedSupplyEndDate: forecast.estimatedSupplyEndDate,
      forecastAssumptions: forecast.assumptionsText,
      isPartialFill,
      createdAt: `${dispensingDate}T00:00:00Z`,
    };
    const projection = computeRefillProjection(
      selectedPlan,
      patient,
      qtyValid ? [...priorEventsWithoutPending, syntheticPendingEvent] : priorEventsWithoutPending,
      lang,
      refDateStr
    );
    return {
      estimatedDailyConsumption: forecast.estimatedDailyConsumption,
      estimatedSupplyDays: forecast.estimatedSupplyDays,
      estimatedSupplyEndDate: forecast.estimatedSupplyEndDate,
      totalDispensedAnalyzed:
        projection.totalDispensedAnalyzed ?? (qtyValid ? dispensedQuantity : 0),
      estimatedRemainingUnits: projection.estimatedRemainingUnits,
      estimatedDaysRemaining: projection.estimatedDaysRemaining,
      refillStatus: projection.refillStatus,
      refillSupplyEndDate: projection.estimatedSupplyEndDate,
      forecastAssumptions: forecast.assumptionsText,
      uncertaintyNote: projection.uncertaintyNote,
      calculationSource: 'provisional_client_unverified',
      algorithmVersion: 'masar_refill_v1',
    };
  }, [
    selectedPlan,
    forecast,
    dispensedQuantity,
    dispensingDate,
    todayStr,
    state.staff,
    state.activeStaffId,
    state.pharmacy.id,
    patient,
    packageCount,
    packageSize,
    batchNumber,
    expiryDate,
    activeUserId,
    notes,
    isPartialFill,
    priorEventsWithoutPending,
    lang,
  ]);

  const idempotencyScopeKey = useMemo(() => {
    if (!selectedPlan) return '';
    return buildDispensingIdempotencyScopeKey(state.pharmacy.id, activeUserId, {
      patientId: patient.id,
      medicationPlanId: selectedPlan.id,
      dispensedQuantity,
      quantityUnit: selectedPlan.doseUnit,
      packageCount: packageCount > 0 ? packageCount : undefined,
      packageSize: packageSize > 0 ? packageSize : undefined,
      batchNumber: batchNumber.trim() || undefined,
      expiryDate: expiryDate || undefined,
      dispensingDate,
      isPartialFill,
      notes: notes.trim() || undefined,
      expectedRegimenVersionNumber: selectedPlan.currentVersionNumber,
      allergyOverrideAuthorization: normalizedOverrideAuth ?? null,
      refillSnapshot: refillSnapshot ?? null,
    });
  }, [
    state.pharmacy.id,
    activeUserId,
    patient.id,
    selectedPlan,
    dispensedQuantity,
    packageCount,
    packageSize,
    batchNumber,
    expiryDate,
    dispensingDate,
    isPartialFill,
    notes,
    normalizedOverrideAuth,
    refillSnapshot,
  ]);

  const clientEventUuid = useMemo(() => {
    void commitSeq;
    return getOrCreatePendingDispensingUuid(idempotencyScopeKey);
  }, [idempotencyScopeKey, commitSeq]);

  const prevScopeKeyRef = useRef<string>(idempotencyScopeKey);
  useEffect(() => {
    if (prevScopeKeyRef.current !== idempotencyScopeKey) {
      prevScopeKeyRef.current = idempotencyScopeKey;
      setUncertainNetworkMsg(null);
    }
  }, [idempotencyScopeKey]);

  const liveValidation = useMemo(() => {
    if (!selectedPlan) return { valid: true, errors: [], warnings: [] };
    return validateDispensingInput(
      {
        patientId: patient.id,
        medicationPlanId: selectedPlan.id,
        dispensedQuantity,
        quantityUnit: selectedPlan.doseUnit,
        packageCount: packageCount > 0 ? packageCount : undefined,
        packageSize: packageSize > 0 ? packageSize : undefined,
        batchNumber: batchNumber.trim() || undefined,
        expiryDate: expiryDate || undefined,
        dispensingDate,
        isPartialFill,
        notes: notes.trim() || undefined,
        expectedRegimenVersionNumber: selectedPlan.currentVersionNumber,
        clientEventUuid,
      },
      lang,
      {
        patient,
        plan: selectedPlan,
        todayStr,
        allowIncompatibleUnit: false,
      }
    );
  }, [
    patient,
    selectedPlan,
    dispensedQuantity,
    packageCount,
    packageSize,
    batchNumber,
    expiryDate,
    dispensingDate,
    isPartialFill,
    notes,
    clientEventUuid,
    lang,
    todayStr,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handlePackChange = (count: number, size: number) => {
    setPackageCount(count);
    setPackageSize(size);
    if (count > 0 && size > 0) {
      setDispensedQuantity(count * size);
    }
  };

  const duplicateSameDay = selectedPlan
    ? findRecentDuplicateDispensing(
        state.dispensingEvents,
        patient.id,
        selectedPlan.id,
        dispensingDate,
        dispensedQuantity
      )
    : undefined;

  const handleRefreshLedger = async () => {
    if (isRefreshingLedger) return;
    setIsRefreshingLedger(true);
    try {
      await refreshState();
      pushToast(
        isAr ? 'تم تحديث سجل الصرف من الخادم.' : 'Dispensing ledger refreshed.',
        'success'
      );
    } catch (err) {
      pushToast(
        err instanceof Error
          ? err.message
          : isAr
            ? 'تعذر تحديث السجل.'
            : 'Unable to refresh ledger.',
        'error'
      );
    } finally {
      setIsRefreshingLedger(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitLockRef.current || isSubmitting) return;
    setErrorMsg(null);
    setUncertainNetworkMsg(null);

    if (isPatientArchived) {
      setErrorMsg(
        isAr
          ? 'لا يمكن صرف علاج لمراجع ملفه مؤرشف.'
          : 'Cannot dispense medication for an archived patient.'
      );
      return;
    }

    if (!selectedPlan) {
      setErrorMsg(
        isAr ? 'لا توجد خطة دوائية نشطة محددة للصرف.' : 'No active medication plan selected.'
      );
      return;
    }
    if (!planConfirmed) {
      setErrorMsg(
        isAr
          ? 'يرجى تأكيد مراجعة الخطة الدوائية الحالية قبل الصرف.'
          : 'Please confirm verification of the active treatment plan.'
      );
      return;
    }
    if (allergyAssessment?.requiresPharmacistAcknowledgment) {
      const overrideCheck = validateAllergyOverrideAuthorization(
        allergyAssessment,
        allergyOverride,
        lang
      );
      if (!overrideCheck.valid) {
        setErrorMsg(overrideCheck.errors[0]);
        return;
      }
    }

    const basePayload = {
      patientId: patient.id,
      medicationPlanId: selectedPlan.id,
      dispensedQuantity,
      quantityUnit: selectedPlan.doseUnit,
      packageCount: packageCount > 0 ? packageCount : undefined,
      packageSize: packageSize > 0 ? packageSize : undefined,
      batchNumber: batchNumber.trim() || undefined,
      expiryDate: expiryDate || undefined,
      dispensingDate,
      isPartialFill,
      notes: notes.trim() || undefined,
      expectedRegimenVersionNumber: selectedPlan.currentVersionNumber,
      clientEventUuid,
    };

    const validation = validateDispensingInput(basePayload, lang, {
      patient,
      plan: selectedPlan,
      todayStr,
      allowIncompatibleUnit: false,
    });
    if (!validation.valid) {
      setErrorMsg(validation.errors[0]);
      return;
    }

    if (duplicateSameDay && !confirmDuplicate) {
      setErrorMsg(
        isAr
          ? 'توجد عملية صرف مطابقة بنفس الكمية والتاريخ اليوم. يرجى تفعيل خيار تأكيد التكرار أدناه للمتابعة.'
          : 'An identical dispensing event exists for this date and quantity. Confirm duplicate check below to proceed.'
      );
      return;
    }

    const inputPayload = {
      ...basePayload,
      refillSnapshot,
      allergyOverrideAuthorization: normalizedOverrideAuth,
      clientPayloadHash: computeDispensingPayloadHash({
        ...basePayload,
        allergyOverrideAuthorization: normalizedOverrideAuth ?? null,
        refillSnapshot: refillSnapshot ?? null,
      }),
    };

    submitLockRef.current = true;
    setIsSubmitting(true);
    try {
      const evt = await recordDispensing(inputPayload);

      if (evt) {
        clearPendingDispensingUuid(idempotencyScopeKey);
        setCommitSeq((c) => c + 1);
        pushToast(
          isAr
            ? `تم تسجيل صرف ${evt.dispensedQuantity} ${evt.quantityUnit} من ${selectedPlan.brandName}.`
            : `Recorded dispensing of ${evt.dispensedQuantity} ${evt.quantityUnit} (${selectedPlan.brandName}).`
        );
        onClose();
      }
    } catch (err) {
      const classified = classifyUncertainNetworkError(err, lang);
      if (classified.isUncertainOutcome) {
        setUncertainNetworkMsg(classified.userMessage);
      }
      setErrorMsg(classified.userMessage);
      pushToast(classified.userMessage, classified.isUncertainOutcome ? 'warning' : 'error');
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dispense-modal-title"
    >
      <div className="bg-white w-full h-full sm:h-auto sm:max-h-[92vh] sm:max-w-xl sm:rounded-xl border border-slate-200 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 id="dispense-modal-title" className="text-lg font-bold text-[#103354]">
              {isAr ? 'تسجيل صرف علاج' : 'Record Medication Dispensing'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {patient.fullName} · <span className="font-mono">{patient.patientCode}</span>
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

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Safety distinction banner */}
          <div className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
            <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <span>
              {isAr
                ? 'تنبيه سريري: تسجيل الصرف يوثّق استلام الكمية وتقدير نفادها فقط، ولا يُعد إثباتاً لتناول المراجع للجرعات.'
                : 'Clinical safety note: Recording dispensing tracks supply handover and refill estimate only; it does not prove patient dose adherence.'}
            </span>
          </div>

          {isPatientArchived && (
            <div
              role="alert"
              className="p-3 bg-[#FEF2F2] border border-[#A80000] rounded-[6px] text-xs text-[#A80000] flex items-start gap-2 font-semibold"
            >
              <AlertOctagon className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {isAr
                  ? 'ملف المراجع مؤرشف. استعد الملف أولاً قبل تسجيل أي صرف دوائي.'
                  : 'Patient profile is archived. Restore the patient before recording dispensing.'}
              </span>
            </div>
          )}

          {uncertainNetworkMsg && (
            <div
              role="status"
              className="p-3 bg-[#FFF4CE] border border-[#E0C878] rounded-[6px] text-xs text-[#242424] space-y-2"
            >
              <div className="flex items-start gap-2 font-semibold">
                <AlertTriangle className="w-4 h-4 text-[#8A6D00] shrink-0 mt-0.5" />
                <span>{uncertainNetworkMsg}</span>
              </div>
              <button
                type="button"
                disabled={isRefreshingLedger}
                onClick={handleRefreshLedger}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-[#0078D4] hover:bg-[#106EBE] disabled:opacity-50 rounded-[4px] inline-flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingLedger ? 'animate-spin' : ''}`} />
                <span>
                  {isAr ? 'تحديث سجل الصرف الآن' : 'Refresh Dispensing Ledger'}
                </span>
              </button>
            </div>
          )}

          {errorMsg && !uncertainNetworkMsg && (
            <div
              role="alert"
              className="p-3 bg-[#FEF2F2] border border-[#A80000] rounded-[6px] text-xs text-[#A80000] flex items-center gap-2 font-semibold"
            >
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {liveValidation.warnings.map((warn, idx) => (
            <div
              key={idx}
              role="status"
              className="p-3 bg-[#FFF4CE] border border-[#E0C878] rounded-[6px] text-xs text-[#242424] flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 text-[#8A6D00] shrink-0 mt-0.5" />
              <span>{warn}</span>
            </div>
          ))}

          {activePlans.length === 0 ? (
            <div className="p-6 text-center border border-dashed border-slate-300 rounded-xl text-sm text-slate-600">
              {isAr
                ? 'لا توجد خطط دوائية نشطة لهذا المراجع حالياً. أضف خطة دوائية أولاً.'
                : 'No active medication plans for this patient. Add a medication plan first.'}
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  {isAr ? 'اختر الخطة الدوائية النشطة *' : 'Select Active Medication Plan *'}
                </label>
                <select
                  value={selectedPlan?.id ?? ''}
                  onChange={(e) => setSelectedPlanId(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg bg-white focus:border-[#008C87] focus:outline-none"
                >
                  {activePlans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.brandName} ({plan.genericName} {plan.strength}) —{' '}
                      {t.dosageForms[plan.dosageForm]}
                    </option>
                  ))}
                </select>
              </div>

              {allergyAssessment && (
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
                  compact
                />
              )}

              {selectedPlan && (
                <div className="p-3.5 bg-[#F5F7FA] border border-slate-200 rounded-lg space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>
                      {isAr ? 'الخطة المعتمدة' : 'Verified Plan'} · v{selectedPlan.currentVersionNumber}
                    </span>
                    <span>{t.foodRelations[selectedPlan.foodRelation]}</span>
                  </div>
                  <p className="text-sm font-medium text-[#103354]">
                    {formatScheduleSummary(selectedPlan.schedule, selectedPlan.doseUnit, lang, use12Hour)}
                  </p>
                  <p className="text-xs text-slate-600">{selectedPlan.verifiedInstructions}</p>
                  <label className="flex items-center gap-2 pt-1 text-xs font-semibold text-[#103354] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={planConfirmed}
                      onChange={(e) => setPlanConfirmed(e.target.checked)}
                      className="w-4 h-4 accent-[#008C87]"
                    />
                    <span>
                      {isAr
                        ? 'أؤكد مطابقة الدواء والجرعة مع الخطة العلاجية المعتمدة'
                        : 'Confirm medication & regimen match verified treatment plan'}
                    </span>
                  </label>
                </div>
              )}

              {/* Packaging helper + Quantity */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'عدد العبوات' : 'Packs'}
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={packageCount}
                    onChange={(e) => handlePackChange(Number(e.target.value), packageSize)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'محتوى العبوة' : 'Units / Pack'}
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={packageSize}
                    onChange={(e) => handlePackChange(packageCount, Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'الكمية الإجمالية المصروفة *' : 'Total Dispensed *'}
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={1}
                      step="any"
                      value={dispensedQuantity}
                      onChange={(e) => setDispensedQuantity(Number(e.target.value))}
                      className="w-full px-3 py-2 text-sm font-bold text-[#103354] border border-slate-300 rounded-lg tabular-nums"
                    />
                    <span className="text-xs text-slate-600 shrink-0">
                      {selectedPlan?.doseUnit}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'تاريخ الصرف *' : 'Dispensing Date *'}
                  </label>
                  <input
                    type="date"
                    value={dispensingDate}
                    onChange={(e) => setDispensingDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'رقم التشغيلة (اختياري)' : 'Batch # (optional)'}
                  </label>
                  <input
                    type="text"
                    value={batchNumber}
                    onChange={(e) => setBatchNumber(e.target.value)}
                    placeholder="B-2026-84"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {isAr ? 'انتهاء الصلاحية (اختياري)' : 'Expiry (optional)'}
                  </label>
                  <input
                    type="date"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isPartialFill}
                  onChange={(e) => setIsPartialFill(e.target.checked)}
                  className="w-4 h-4 accent-[#008C87]"
                />
                <span>
                  {isAr
                    ? 'صرف جزئي (أقل من دورة العلاج المعتادة)'
                    : 'Partial fill (less than standard treatment cycle)'}
                </span>
              </label>

              {duplicateSameDay && (
                <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-950 space-y-1.5">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                    <span>
                      {isAr
                        ? 'تنبيه تكرار محتمل: تم تسجيل صرف مماثل بنفس الكمية في هذا التاريخ.'
                        : 'Possible duplicate: an identical dispensing quantity exists on this date.'}
                    </span>
                  </div>
                  <label className="flex items-center gap-2 font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={confirmDuplicate}
                      onChange={(e) => setConfirmDuplicate(e.target.checked)}
                      className="w-4 h-4 accent-[#103354]"
                    />
                    <span>
                      {isAr ? 'تأكيد تسجيل عملية صرف إضافية' : 'Confirm recording additional dispense'}
                    </span>
                  </label>
                </div>
              )}

              {/* Forecast Preview */}
              {forecast && (
                <div className="p-3.5 bg-teal-50/70 border border-teal-200 rounded-lg space-y-1.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#008C87]">
                    <span className="flex items-center gap-1.5">
                      <Calendar className="w-4 h-4" />
                      {isAr ? 'توقع إعادة الصرف (تقدير محسوب)' : 'Refill Projection (Calculated Estimate)'}
                    </span>
                    <span className="font-mono tabular-nums">
                      {forecast.estimatedSupplyDays !== null
                        ? `${forecast.estimatedSupplyDays} ${t.common.days}`
                        : t.refillStatus.unable_to_estimate}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-bold text-[#103354]">
                    <span>
                      {isAr ? 'تاريخ النفاد المتوقع:' : 'Estimated supply end:'}{' '}
                      <span className="tabular-nums">
                        {forecast.estimatedSupplyEndDate
                          ? formatDate(forecast.estimatedSupplyEndDate, lang)
                          : t.refillStatus.unable_to_estimate}
                      </span>
                    </span>
                    {forecast.estimatedDailyConsumption !== null && (
                      <span className="text-xs font-medium text-slate-600 tabular-nums">
                        {forecast.estimatedDailyConsumption} {selectedPlan?.doseUnit}/
                        {isAr ? 'يوم' : 'day'}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-600">{forecast.assumptionsText}</p>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {isAr ? 'ملاحظات الصرف' : 'Dispensing Notes'}
                </label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={isAr ? 'مثال: تم شرح طريقة الاستخدام للمريض...' : 'Optional notes...'}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </>
          )}
        </form>

        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 min-h-[42px]"
          >
            {t.common.cancel}
          </button>
          {activePlans.length > 0 && (
            <button
              type="button"
              disabled={isSubmitting || isPatientArchived}
              onClick={handleSubmit}
              className="px-5 py-2.5 text-sm font-semibold text-white bg-[#008C87] hover:bg-[#00736F] disabled:opacity-50 rounded-lg inline-flex items-center gap-2 min-h-[42px]"
            >
              <Package className="w-4 h-4" />
              <span>{isAr ? 'تأكيد وحفظ الصرف' : 'Save Dispensing Event'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
