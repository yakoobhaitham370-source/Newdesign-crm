import React, { useMemo, useState } from 'react';
import { CalendarClock, ChevronDown, ChevronUp, ClipboardPlus, Pill } from 'lucide-react';
import { DispenseModal } from '../components/modals/DispenseModal';
import { useCrm } from '../context/CrmContext';
import { formatDate, LABELS } from '../i18n/translations';
import { Patient, RefillStatus } from '../types/domain';

export const RefillsView: React.FC = () => {
  const { lang, state, todayStr, refillProjections, navigateTo, addFollowUp, pushToast } = useCrm();
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const [statusFilter, setStatusFilter] = useState<RefillStatus | 'all'>('all');
  // Mandatory rule: collapsible Refill Timeline & Adherence Pattern closed by default
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [dispenseTarget, setDispenseTarget] = useState<{
    patient: Patient;
    planId: string;
  } | null>(null);

  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return refillProjections;
    return refillProjections.filter((r) => r.refillStatus === statusFilter);
  }, [refillProjections, statusFilter]);

  const handleCreateFollowUp = async (patientId: string, planId: string, medLabel: string) => {
    if (busyPlanId) return;
    setBusyPlanId(planId);
    try {
      await addFollowUp({
        patientId,
        relatedMedicationPlanId: planId,
        type: 'refill',
        dueDate: todayStr,
        status: 'pending',
        notes: isAr
          ? `متابعة إعادة صرف: ${medLabel}`
          : `Refill follow-up for: ${medLabel}`,
        assignedStaffName:
          state.staff.find((s) => s.id === state.activeStaffId)?.fullName ??
          state.staff[0]?.fullName ??
          '',
      });
      pushToast(isAr ? 'تمت إضافة مهمة متابعة لإعادة الصرف.' : 'Refill follow-up task created.');
    } catch (err) {
      pushToast(
        err instanceof Error
          ? err.message
          : isAr
            ? 'تعذر إنشاء مهمة المتابعة.'
            : 'Unable to create follow-up task.',
        'error'
      );
    } finally {
      setBusyPlanId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-[#103354]">
            {isAr ? 'مراقبة إعادة الصرف وتقدير الرصيد' : 'Refill Monitoring & Supply Forecasts'}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {isAr
              ? 'جميع التواريخ المتبقية هي تقديرات محسوبة تعتمد على افتراض الالتزام وتأخذ الصرف الجزئي وتعديل الجرعات بالاعتبار.'
              : 'All supply-end dates are calculated estimates accounting for partial fills, paused plans, and regimen changes.'}
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5 p-1 bg-slate-100 rounded-lg">
          {(
            [
              'all',
              'overdue',
              'due_soon',
              'upcoming',
              'on_track',
              'unable_to_estimate',
              'paused_or_prn',
            ] as const
          ).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors min-h-[38px] ${
                statusFilter === st
                  ? 'bg-white text-[#103354] shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {st === 'all' ? t.common.all : t.refillStatus[st]}
            </button>
          ))}
        </div>
      </div>

      {/* Refills List */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">{t.common.noData}</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filtered.map((item) => {
              const patient = state.patients.find((p) => p.id === item.patientId);
              return (
                <div
                  key={item.medicationPlanId}
                  className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-50/70"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => navigateTo('patient-detail', item.patientId)}
                        className="text-base font-bold text-[#103354] hover:text-[#008C87]"
                      >
                        {item.patientName}
                      </button>
                      <span className="font-mono text-xs text-slate-500">{item.patientCode}</span>
                      <span className="text-slate-300">·</span>
                      <span
                        className={`text-xs font-bold ${
                          item.refillStatus === 'overdue'
                            ? 'text-red-700'
                            : item.refillStatus === 'due_soon'
                              ? 'text-amber-700'
                              : item.refillStatus === 'paused_or_prn' ||
                                  item.refillStatus === 'unable_to_estimate'
                                ? 'text-slate-600'
                                : 'text-[#008C87]'
                        }`}
                      >
                        {t.refillStatus[item.refillStatus]}
                      </span>
                    </div>
                    <div className="text-sm font-medium text-slate-800">{item.medicationLabel}</div>
                    <div className="text-xs text-slate-500 flex flex-wrap gap-3 tabular-nums">
                      <span>
                        {isAr ? 'آخر صرف:' : 'Last dispensed:'}{' '}
                        {item.lastDispensedDate
                          ? formatDate(item.lastDispensedDate, lang)
                          : isAr
                            ? 'لم يُصرف بعد'
                            : 'Not dispensed yet'}
                      </span>
                      <span>·</span>
                      <span>
                        {isAr ? 'الكمية المتبقية (تقدير):' : 'Est. remaining:'}{' '}
                        {item.estimatedRemainingUnits !== null
                          ? `${item.estimatedRemainingUnits} ${item.quantityUnit}`
                          : t.refillStatus.unable_to_estimate}
                      </span>
                      <span>·</span>
                      <span>
                        {isAr ? 'تاريخ النفاد المتوقع:' : 'Est. end:'}{' '}
                        {item.estimatedSupplyEndDate
                          ? formatDate(item.estimatedSupplyEndDate, lang)
                          : t.refillStatus.unable_to_estimate}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500">{item.uncertaintyNote}</div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {patient && item.medicationStatus === 'active' && (
                      <button
                        type="button"
                        onClick={() =>
                          setDispenseTarget({ patient, planId: item.medicationPlanId })
                        }
                        className="px-3.5 py-2 text-xs font-semibold text-white bg-[#008C87] hover:bg-[#00736F] rounded-lg inline-flex items-center gap-1.5 min-h-[38px]"
                      >
                        <Pill className="w-3.5 h-3.5" />
                        <span>{isAr ? 'صرف إعادة تعبئة' : 'Record Refill'}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busyPlanId === item.medicationPlanId}
                      onClick={() =>
                        void handleCreateFollowUp(
                          item.patientId,
                          item.medicationPlanId,
                          item.medicationLabel
                        )
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-[#103354] border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 rounded-lg inline-flex items-center gap-1.5 min-h-[38px]"
                    >
                      <ClipboardPlus className="w-3.5 h-3.5" />
                      <span>{isAr ? 'إضافة متابعة' : 'Follow-up Task'}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Collapsible Refill Timeline & Adherence Pattern — CLOSED BY DEFAULT */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setTimelineOpen((v) => !v)}
          className="w-full px-5 py-4 flex items-center justify-between text-start hover:bg-slate-50"
          aria-expanded={timelineOpen}
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
                  ? 'مغلق افتراضياً — افتح لعرض التغطية الزمنية التاريخية مقارنة بمواعيد الصرف'
                  : 'Closed by default — expand to view historical refill coverage timeline'}
              </div>
            </div>
          </div>
          {timelineOpen ? (
            <ChevronUp className="w-5 h-5 text-slate-500" />
          ) : (
            <ChevronDown className="w-5 h-5 text-slate-500" />
          )}
        </button>

        {timelineOpen && (
          <div className="px-5 pb-5 pt-2 border-t border-slate-200 space-y-2.5">
            {state.dispensingEvents.slice(0, 8).map((evt) => {
              const pat = state.patients.find((p) => p.id === evt.patientId);
              const med = state.medicationPlans.find((m) => m.id === evt.medicationPlanId);
              return (
                <div
                  key={evt.id}
                  className="p-3 bg-[#F5F7FA] border border-slate-200 rounded-lg text-xs flex flex-wrap items-center justify-between gap-2"
                >
                  <div>
                    <span className="font-bold text-[#103354]">{pat?.fullName}</span> ·{' '}
                    <span>{med?.brandName}</span>
                  </div>
                  <div className="tabular-nums text-slate-600">
                    {formatDate(evt.dispensingDate, lang)} →{' '}
                    {evt.estimatedSupplyEndDate
                      ? formatDate(evt.estimatedSupplyEndDate, lang)
                      : '—'}{' '}
                    ({evt.dispensedQuantity} {evt.quantityUnit})
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dispenseTarget && (
        <DispenseModal
          isOpen={true}
          onClose={() => setDispenseTarget(null)}
          patient={dispenseTarget.patient}
          initialPlanId={dispenseTarget.planId}
        />
      )}
    </div>
  );
};
