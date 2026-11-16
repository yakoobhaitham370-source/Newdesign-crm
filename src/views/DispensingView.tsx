import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Calendar, CheckCircle2, Info, Package, RefreshCw, Search } from 'lucide-react';
import { useCrm } from '../context/CrmContext';
import { formatDate, LABELS } from '../i18n/translations';
import {
  assessMedicationAllergyRisk,
  classifyUncertainNetworkError,
  computeDispensingPayloadHash,
  DispensingRefillSnapshotInput,
  toAllergyOverrideLevel,
  validateAllergyOverrideAuthorization,
  validateDispensingInput,
} from '../services/clinicalSafety';
import { findRecentDuplicateDispensing } from '../services/crmRepository';
import {
  buildDispensingIdempotencyScopeKey,
  clearPendingDispensingUuid,
  getOrCreatePendingDispensingUuid,
  getPendingDispensingUuids,
} from '../services/dispensingIdempotencyStore';
import {
  calculateDispensingForecast,
  computeRefillProjection,
  formatScheduleSummary,
} from '../services/scheduleEngine';
import { AllergySafetyBanner } from '../components/common/AllergySafetyBanner';
import { AllergyOverrideAuthorization, DispensingEvent } from '../types/domain';

export const DispensingView: React.FC = () => {
  const {
    lang,
    use12Hour,
    state,
    todayStr,
    authenticatedPharmacist,
    backendCapabilities,
    navigateTo,
    recordDispensing,
    refreshState,
    refreshBackendCapabilities,
    pushToast,
  } = useCrm();
  const activeUserId = authenticatedPharmacist?.userId ?? state.activeStaffId;
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const activePatients = useMemo(
    () => state.patients.filter((p) => p.status === 'active'),
    [state.patients]
  );

  const [selectedPatientId, setSelectedPatientId] = useState<string>(
    activePatients[0]?.id ?? ''
  );
  const selectedPatient = activePatients.find((p) => p.id === selectedPatientId);

  const patientActivePlans = useMemo(
    () =>
      state.medicationPlans.filter(
        (m) => m.patientId === selectedPatientId && m.status === 'active'
      ),
    [state.medicationPlans, selectedPatientId]
  );

  const [selectedPlanId, setSelectedPlanId] = useState<string>('');
  const effectivePlan =
    patientActivePlans.find((m) => m.id === selectedPlanId) ?? patientActivePlans[0];

  const [packageCount, setPackageCount] = useState<number>(1);
  const [packageSize, setPackageSize] = useState<number>(30);
  const [dispensedQuantity, setDispensedQuantity] = useState<number>(30);
  const [dispensingDate, setDispensingDate] = useState<string>(todayStr);
  const prevTodayRef = useRef<string>(todayStr);
  const [batchNumber, setBatchNumber] = useState<string>('');
  const [expiryDate, setExpiryDate] = useState<string>('');
  const [isPartialFill, setIsPartialFill] = useState<boolean>(false);
  const [planConfirmed, setPlanConfirmed] = useState<boolean>(true);
  const [notes, setNotes] = useState<string>('');
  const [ledgerSearch, setLedgerSearch] = useState<string>('');
  const [confirmDuplicate, setConfirmDuplicate] = useState<boolean>(false);
  const [allergyOverride, setAllergyOverride] = useState<AllergyOverrideAuthorization>({
    acknowledged: false,
    authorizationSource: 'prescriber_written_order',
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uncertainNetworkMsg, setUncertainNetworkMsg] = useState<string | null>(null);
  const [isRefreshingLedger, setIsRefreshingLedger] = useState<boolean>(false);
  const [commitSeq, setCommitSeq] = useState<number>(0);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const submitLockRef = useRef<boolean>(false);

  useEffect(() => {
    if (dispensingDate === prevTodayRef.current) {
      setDispensingDate(todayStr);
    }
    prevTodayRef.current = todayStr;
  }, [todayStr, dispensingDate]);

  const effectivePlanIdActual = effectivePlan?.id ?? '';
  useEffect(() => {
    setAllergyOverride({
      acknowledged: false,
      authorizationSource: 'prescriber_written_order',
    });
    setErrorMsg(null);
  }, [selectedPatientId, effectivePlanIdActual]);

  const allergyAssessment = useMemo(() => {
    if (!selectedPatient || !effectivePlan) return null;
    return assessMedicationAllergyRisk(
      selectedPatient,
      {
        catalogId: effectivePlan.catalogId,
        brandName: effectivePlan.brandName,
        genericName: effectivePlan.genericName,
        strength: effectivePlan.strength,
      },
      lang
    );
  }, [selectedPatient, effectivePlan, lang]);

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
      effectivePlan
        ? calculateDispensingForecast(effectivePlan, dispensedQuantity, dispensingDate, lang)
        : null,
    [effectivePlan, dispensedQuantity, dispensingDate, lang]
  );

  const refillSnapshot = useMemo<DispensingRefillSnapshotInput | undefined>(() => {
    if (!selectedPatient || !effectivePlan || !forecast) return undefined;
    const qtyValid = Number.isFinite(dispensedQuantity) && dispensedQuantity > 0;
    const refDateStr = dispensingDate > todayStr ? dispensingDate : todayStr;
    const staff = state.staff.find((s) => s.id === state.activeStaffId);
    const syntheticPendingEvent: DispensingEvent = {
      id: 'pending-fill',
      pharmacyId: state.pharmacy.id,
      patientId: selectedPatient.id,
      medicationPlanId: effectivePlan.id,
      regimenVersionNumber: effectivePlan.currentVersionNumber,
      dispensedQuantity: qtyValid ? dispensedQuantity : 0,
      quantityUnit: effectivePlan.doseUnit,
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
      effectivePlan,
      selectedPatient,
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
    selectedPatient,
    effectivePlan,
    forecast,
    dispensedQuantity,
    dispensingDate,
    todayStr,
    state.staff,
    state.activeStaffId,
    state.pharmacy.id,
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
    if (!selectedPatient || !effectivePlan) return '';
    return buildDispensingIdempotencyScopeKey(state.pharmacy.id, activeUserId, {
      patientId: selectedPatient.id,
      medicationPlanId: effectivePlan.id,
      dispensedQuantity,
      quantityUnit: effectivePlan.doseUnit,
      packageCount: packageCount > 0 ? packageCount : undefined,
      packageSize: packageSize > 0 ? packageSize : undefined,
      batchNumber: batchNumber.trim() || undefined,
      expiryDate: expiryDate || undefined,
      dispensingDate,
      isPartialFill,
      notes: notes.trim() || undefined,
      expectedRegimenVersionNumber: effectivePlan.currentVersionNumber,
      allergyOverrideAuthorization: normalizedOverrideAuth ?? null,
      refillSnapshot: refillSnapshot ?? null,
    });
  }, [
    state.pharmacy.id,
    activeUserId,
    selectedPatient,
    effectivePlan,
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
    if (!selectedPatient || !effectivePlan) return { valid: true, errors: [], warnings: [] };
    return validateDispensingInput(
      {
        patientId: selectedPatient.id,
        medicationPlanId: effectivePlan.id,
        dispensedQuantity,
        quantityUnit: effectivePlan.doseUnit,
        packageCount: packageCount > 0 ? packageCount : undefined,
        packageSize: packageSize > 0 ? packageSize : undefined,
        batchNumber: batchNumber.trim() || undefined,
        expiryDate: expiryDate || undefined,
        dispensingDate,
        isPartialFill,
        notes: notes.trim() || undefined,
        expectedRegimenVersionNumber: effectivePlan.currentVersionNumber,
        clientEventUuid,
      },
      lang,
      {
        patient: selectedPatient,
        plan: effectivePlan,
        todayStr,
        allowIncompatibleUnit: false,
      }
    );
  }, [
    selectedPatient,
    effectivePlan,
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

  const duplicateSameDay =
    selectedPatient && effectivePlan
      ? findRecentDuplicateDispensing(
          state.dispensingEvents,
          selectedPatient.id,
          effectivePlan.id,
          dispensingDate,
          dispensedQuantity
        )
      : undefined;

  const handlePackChange = (cnt: number, sz: number) => {
    setPackageCount(cnt);
    setPackageSize(sz);
    if (cnt > 0 && sz > 0) setDispensedQuantity(cnt * sz);
  };

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
            ? 'تعذر تحديث سجل الصرف.'
            : 'Unable to refresh ledger.',
        'error'
      );
    } finally {
      setIsRefreshingLedger(false);
    }
  };

  const handleDispenseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitLockRef.current || isSubmitting) return;
    setErrorMsg(null);
    setUncertainNetworkMsg(null);

    if (!selectedPatient || !effectivePlan) {
      const msg = isAr ? 'اختر المراجع والخطة الدوائية النشطة أولاً.' : 'Select patient and active plan.';
      setErrorMsg(msg);
      pushToast(msg, 'error');
      return;
    }
    if (!planConfirmed) {
      const msg = isAr ? 'يرجى تأكيد مطابقة الخطة الدوائية.' : 'Confirm treatment plan verification.';
      setErrorMsg(msg);
      pushToast(msg, 'error');
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
        pushToast(overrideCheck.errors[0], 'error');
        return;
      }
    }

    const basePayload = {
      patientId: selectedPatient.id,
      medicationPlanId: effectivePlan.id,
      dispensedQuantity,
      quantityUnit: effectivePlan.doseUnit,
      packageCount: packageCount > 0 ? packageCount : undefined,
      packageSize: packageSize > 0 ? packageSize : undefined,
      batchNumber: batchNumber.trim() || undefined,
      expiryDate: expiryDate || undefined,
      dispensingDate,
      isPartialFill,
      notes: notes.trim() || undefined,
      expectedRegimenVersionNumber: effectivePlan.currentVersionNumber,
      clientEventUuid,
    };

    const validation = validateDispensingInput(basePayload, lang, {
      patient: selectedPatient,
      plan: effectivePlan,
      todayStr,
      allowIncompatibleUnit: false,
    });
    if (!validation.valid) {
      setErrorMsg(validation.errors[0]);
      pushToast(validation.errors[0], 'error');
      return;
    }

    if (duplicateSameDay && !confirmDuplicate) {
      const msg = isAr
        ? 'توجد عملية صرف مطابقة اليوم — يرجى تأكيد خيار السماح بالإضافة المكررة.'
        : 'Identical dispense found for today — confirm duplicate check to proceed.';
      setErrorMsg(msg);
      pushToast(msg, 'warning');
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
        setNotes('');
        setBatchNumber('');
        setExpiryDate('');
        setConfirmDuplicate(false);
        setAllergyOverride({
          acknowledged: false,
          authorizationSource: 'prescriber_written_order',
        });
        setCommitSeq((c) => c + 1);
        pushToast(
          isAr
            ? `تم صرف ${evt.dispensedQuantity} ${evt.quantityUnit} من ${effectivePlan.brandName} للمراجع ${selectedPatient.fullName}.`
            : `Dispensed ${evt.dispensedQuantity} ${evt.quantityUnit} of ${effectivePlan.brandName}.`
        );
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

  const filteredLedger = useMemo(() => {
    const q = ledgerSearch.trim().toLowerCase();
    return state.dispensingEvents
      .slice()
      .sort(
        (a, b) =>
          b.dispensingDate.localeCompare(a.dispensingDate) ||
          b.createdAt.localeCompare(a.createdAt)
      )
      .filter((evt) => {
        if (!q) return true;
        const p = state.patients.find((pat) => pat.id === evt.patientId);
        const m = state.medicationPlans.find((med) => med.id === evt.medicationPlanId);
        return (
          p?.fullName.toLowerCase().includes(q) ||
          p?.patientCode.toLowerCase().includes(q) ||
          m?.brandName.toLowerCase().includes(q) ||
          m?.genericName.toLowerCase().includes(q)
        );
      });
  }, [state.dispensingEvents, state.patients, state.medicationPlans, ledgerSearch]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Left: Comprehensive Dispensing Form */}
      <form
        onSubmit={handleDispenseSubmit}
        className="xl:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
      >
        <div>
          <h2 className="text-lg font-bold text-[#103354]">
            {isAr ? 'صرف علاج وتحديث توقع النفاد' : 'Dispense Medication'}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {isAr
              ? 'اختر المراجع والخطة الموثقة لحساب الرصيد التقديري وتاريخ إعادة الصرف'
              : 'Select patient and verified plan to record supply handover and calculate refill projection'}
          </p>
        </div>

        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-start gap-2">
          <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <span>
            {isAr
              ? 'توثيق الصرف لا يثبت التزام المريض بتناول الجرعات؛ الالتزام يُسجل بشكل منفصل عبر تأكيدات المريض.'
              : 'Dispensing records supply handover only and does not prove medication intake adherence.'}
          </span>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            {isAr ? '١. المراجع *' : '1. Patient *'}
          </label>
          <select
            value={selectedPatientId}
            onChange={(e) => {
              setSelectedPatientId(e.target.value);
              setSelectedPlanId('');
            }}
            className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg bg-white"
          >
            {activePatients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName} ({p.patientCode})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            {isAr ? '٢. الخطة الدوائية النشطة *' : '2. Active Medication Plan *'}
          </label>
          {patientActivePlans.length === 0 ? (
            <div className="p-3 border border-dashed border-slate-300 rounded-lg text-xs text-slate-600">
              {isAr
                ? 'لا توجد خطط نشطة لهذا المراجع. افتح ملفه لإضافة خطة دوائية.'
                : 'No active plans for this patient. Open profile to add one.'}
            </div>
          ) : (
            <select
              value={effectivePlan?.id ?? ''}
              onChange={(e) => setSelectedPlanId(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg bg-white"
            >
              {patientActivePlans.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.brandName} ({m.genericName} {m.strength})
                </option>
              ))}
            </select>
          )}
        </div>

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

        {effectivePlan && (
          <div className="p-3.5 bg-[#F5F7FA] border border-slate-200 rounded-lg space-y-2">
            <div className="flex items-center justify-between text-xs font-bold text-[#103354]">
              <span>{isAr ? '٣. مراجعة الخطة المعتمدة:' : '3. Verified Regimen:'}</span>
              <span className="text-slate-500 font-normal">v{effectivePlan.currentVersionNumber}</span>
            </div>
            <div className="text-xs text-[#008C87] font-semibold">
              {formatScheduleSummary(effectivePlan.schedule, effectivePlan.doseUnit, lang, use12Hour)}
            </div>
            <p className="text-xs text-slate-600">{effectivePlan.verifiedInstructions}</p>
            <label className="flex items-center gap-2 text-xs font-semibold text-[#103354] pt-1 cursor-pointer">
              <input
                type="checkbox"
                checked={planConfirmed}
                onChange={(e) => setPlanConfirmed(e.target.checked)}
                className="w-4 h-4 accent-[#008C87]"
              />
              <span>
                {isAr ? 'تم التحقق من مطابقة الدواء والجرعة' : 'Confirmed plan & instructions match'}
              </span>
            </label>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2.5">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              {isAr ? 'العبوات' : 'Packs'}
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
              {isAr ? 'حجم العبوة' : 'Pack Size'}
            </label>
            <input
              type="number"
              min={0}
              value={packageSize}
              onChange={(e) => handlePackChange(packageCount, Number(e.target.value))}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              {isAr ? 'الإجمالي *' : 'Total Qty *'}
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
              {effectivePlan && (
                <span className="text-[11px] text-slate-600 shrink-0">
                  {effectivePlan.doseUnit}
                </span>
              )}
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
          <span>{isAr ? 'صرف جزئي' : 'Partial fill'}</span>
        </label>

        {duplicateSameDay && (
          <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-950 space-y-1.5">
            <div className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
              <span>
                {isAr
                  ? 'تنبيه تكرار: تم تسجيل صرف بنفس الكمية في هذا التاريخ.'
                  : 'Duplicate warning: identical quantity already dispensed on this date.'}
              </span>
            </div>
            <label className="flex items-center gap-2 font-semibold cursor-pointer">
              <input
                type="checkbox"
                checked={confirmDuplicate}
                onChange={(e) => setConfirmDuplicate(e.target.checked)}
                className="w-4 h-4 accent-[#103354]"
              />
              <span>{isAr ? 'تأكيد تسجيل صرف إضافي' : 'Confirm additional dispense'}</span>
            </label>
          </div>
        )}

        {forecast && (
          <div className="p-3.5 bg-teal-50/70 border border-teal-200 rounded-lg space-y-1 text-xs">
            <div className="font-bold text-[#008C87] flex items-center gap-1.5">
              <Calendar className="w-4 h-4" />
              <span>{isAr ? 'تقدير تاريخ إعادة الصرف القادم:' : 'Estimated Supply End Date:'}</span>
            </div>
            <div className="text-sm font-bold text-[#103354] tabular-nums">
              {forecast.estimatedSupplyEndDate
                ? `${formatDate(forecast.estimatedSupplyEndDate, lang)} (${forecast.estimatedSupplyDays} ${t.common.days})`
                : t.refillStatus.unable_to_estimate}
            </div>
            <div className="text-[11px] text-slate-600">{forecast.assumptionsText}</div>
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            {t.common.notes}
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={isAr ? 'ملاحظات إضافية عند التسليم...' : 'Optional handover notes...'}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
        </div>

        <button
          type="submit"
          disabled={!effectivePlan || isSubmitting}
          className="w-full py-3 px-4 text-sm font-semibold text-white bg-[#008C87] hover:bg-[#00736F] disabled:opacity-50 rounded-lg inline-flex items-center justify-center gap-2 min-h-[44px]"
        >
          <Package className="w-4 h-4" />
          <span>{isAr ? 'تأكيد وحفظ عملية الصرف' : 'Record Dispensing Event'}</span>
        </button>
      </form>

      {/* Right: Dispensing Ledger */}
      <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h3 className="text-base font-bold text-[#103354]">
            {isAr ? 'سجل الصرف الدوائي' : 'Dispensing History Ledger'}
          </h3>
          <div className="relative sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute top-2.5 start-3" />
            <input
              type="text"
              value={ledgerSearch}
              onChange={(e) => setLedgerSearch(e.target.value)}
              placeholder={t.common.search}
              className="w-full ps-9 pe-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        {filteredLedger.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">{t.common.noData}</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredLedger.map((evt) => {
              const pat = state.patients.find((p) => p.id === evt.patientId);
              const med = state.medicationPlans.find((m) => m.id === evt.medicationPlanId);
              return (
                <div
                  key={evt.id}
                  className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-slate-50/60"
                >
                  <div>
                    <button
                      type="button"
                      onClick={() => pat && navigateTo('patient-detail', pat.id)}
                      className="text-sm font-bold text-[#103354] hover:text-[#008C87]"
                    >
                      {pat?.fullName ?? '—'}
                    </button>
                    <div className="text-xs text-slate-600 mt-0.5">
                      {med ? `${med.brandName} (${med.strength})` : evt.medicationPlanId} ·{' '}
                      <strong className="tabular-nums">
                        {evt.dispensedQuantity} {evt.quantityUnit}
                      </strong>
                      {evt.isPartialFill && (
                        <span className="text-amber-700 ms-1.5">
                          ({isAr ? 'صرف جزئي' : 'Partial'})
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {evt.dispensedByStaffName} ·{' '}
                      <span className="tabular-nums">{formatDate(evt.dispensingDate, lang)}</span>
                    </div>
                  </div>
                  <div className="text-end text-xs">
                    <div className="text-[#008C87] font-semibold tabular-nums">
                      {evt.estimatedSupplyEndDate
                        ? `${t.common.estimateLabel}: ${formatDate(evt.estimatedSupplyEndDate, lang)}`
                        : '—'}
                    </div>
                    <div className="text-[11px] text-slate-500 flex items-center sm:justify-end gap-1 mt-0.5">
                      <CheckCircle2 className="w-3 h-3 text-[#008C87]" />
                      <span>{isAr ? 'موثق بالخطة' : 'Plan verified'}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
