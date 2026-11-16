import React, { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  ClipboardCheck,
  HeartPulse,
  MessageSquare,
  Pill,
  Plus,
  UserPlus,
  Users,
} from 'lucide-react';
import { PatientFormModal } from '../components/modals/PatientFormModal';
import { useCrm } from '../context/CrmContext';
import { formatDate, formatDateTime, LABELS } from '../i18n/translations';
import { getAuditLogDisplaySummary } from '../services/auditDisplayHelper';

export const DashboardView: React.FC = () => {
  const { lang, state, isConnectedMode, todayStr, kpis, refillProjections, navigateTo } = useCrm();
  const isAr = lang === 'ar';
  const t = LABELS[lang];
  const [showAddPatient, setShowAddPatient] = useState(false);

  const urgentRefills = refillProjections
    .filter((r) => r.refillStatus === 'overdue' || r.refillStatus === 'due_soon' || r.refillStatus === 'upcoming')
    .slice(0, 5);

  const pendingFollowUps = state.followUps
    .filter((f) => f.status !== 'completed')
    .slice(0, 4);

  const kpiCards = [
    {
      label: isAr ? 'إجمالي المرضى النشطين' : 'Total Active Patients',
      value: kpis.totalPatients,
      icon: Users,
      tone: 'navy' as const,
      onClick: () => navigateTo('patients'),
    },
    {
      label: isAr ? 'مرضى الحالات المزمنة' : 'Active Chronic Patients',
      value: kpis.activeChronicPatients,
      icon: HeartPulse,
      tone: 'teal' as const,
      onClick: () => navigateTo('patients'),
    },
    {
      label: isAr ? 'الخطط الدوائية النشطة' : 'Active Medication Plans',
      value: kpis.activeMedicationPlans,
      icon: Pill,
      tone: 'navy' as const,
      onClick: () => navigateTo('patients'),
    },
    {
      label: isAr ? 'إعادة صرف مستحقة قريباً' : 'Refills Due Soon (≤7d)',
      value: kpis.refillsDueSoonCount,
      icon: CalendarClock,
      tone: kpis.refillsDueSoonCount > 0 ? ('amber' as const) : ('teal' as const),
      onClick: () => navigateTo('refills'),
    },
    {
      label: isAr ? 'مرضى بحاجة لمتابعة' : 'Patients Needing Follow-up',
      value: kpis.patientsRequiringFollowUp,
      icon: ClipboardCheck,
      tone: kpis.patientsRequiringFollowUp > 0 ? ('amber' as const) : ('teal' as const),
      onClick: () => navigateTo('followups'),
    },
    {
      label: isAr ? 'عمليات الصرف اليوم' : "Today's Dispensing Events",
      value: kpis.todaysDispensingCount,
      icon: Pill,
      tone: 'teal' as const,
      onClick: () => navigateTo('dispensing'),
    },
  ];

  const ArrowIcon = isAr ? ArrowLeft : ArrowRight;

  return (
    <div className="space-y-6">
      {/* Pharmacy Workspace Header + Quick Actions */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <div className="text-xs font-medium text-slate-500">
            {isAr ? state.pharmacy.nameAr : state.pharmacy.nameEn} · {state.pharmacy.city} ·{' '}
            <span className="tabular-nums">{formatDate(todayStr, lang)}</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-[#103354] mt-1">
            {isAr ? 'لوحة متابعة المرضى المزمنين' : 'Chronic Care Pharmacy Operations'}
          </h2>
          <p className="text-xs sm:text-sm text-slate-600 mt-1">
            {isConnectedMode
              ? isAr
                ? 'جميع المؤشرات التالية محسوبة لحظياً من سجلات صيدليتك الموثقة في Supabase PostgreSQL.'
                : 'All KPIs below are computed dynamically from your pharmacy’s verified PostgreSQL records.'
              : isAr
                ? 'جميع المؤشرات التالية محسوبة لحظياً من سجل البيانات التجريبية للمرحلة ١.'
                : 'All KPIs below are computed dynamically from the Stage 1 demonstration repository.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowAddPatient(true)}
            className="px-4 py-2.5 text-sm font-semibold text-white bg-[#103354] hover:bg-[#0B253E] rounded-lg inline-flex items-center gap-2 min-h-[42px] whitespace-nowrap"
          >
            <UserPlus className="w-4 h-4" />
            <span>{isAr ? 'تسجيل مراجع جديد' : 'Add Patient'}</span>
          </button>
          <button
            type="button"
            onClick={() => navigateTo('dispensing')}
            className="px-4 py-2.5 text-sm font-semibold text-white bg-[#008C87] hover:bg-[#00736F] rounded-lg inline-flex items-center gap-2 min-h-[42px] whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>{isAr ? 'صرف علاج' : 'Dispense Medication'}</span>
          </button>
          <button
            type="button"
            onClick={() => navigateTo('consultations')}
            className="px-3.5 py-2.5 text-sm font-medium text-[#103354] bg-white border border-slate-300 hover:bg-slate-50 rounded-lg inline-flex items-center gap-2 min-h-[42px] whitespace-nowrap"
          >
            <MessageSquare className="w-4 h-4 text-[#008C87]" />
            <span>{t.nav.consultations}</span>
          </button>
        </div>
      </div>

      {/* 6 Dynamic KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {kpiCards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.label}
              type="button"
              onClick={card.onClick}
              className="bg-white border border-slate-200 hover:border-slate-300 rounded-xl p-5 text-start transition-colors flex items-center justify-between gap-4"
            >
              <div>
                <div className="text-xs font-medium text-slate-500">{card.label}</div>
                <div
                  className={`text-3xl font-bold tabular-nums mt-1.5 ${
                    card.tone === 'amber'
                      ? 'text-amber-700'
                      : card.tone === 'teal'
                        ? 'text-[#008C87]'
                        : 'text-[#103354]'
                  }`}
                >
                  {card.value}
                </div>
              </div>
              <div
                className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                  card.tone === 'amber'
                    ? 'bg-amber-50 text-amber-700'
                    : card.tone === 'teal'
                      ? 'bg-teal-50 text-[#008C87]'
                      : 'bg-slate-100 text-[#103354]'
                }`}
              >
                <Icon className="w-5 h-5" />
              </div>
            </button>
          );
        })}
      </div>

      {/* Main Split: Refills Due Soon + Follow-ups & Recent Activity */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Refills Due Projection Table */}
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-[#103354]">
                {isAr ? 'مواعيد إعادة الصرف القادمة والمتأخرة' : 'Upcoming & Overdue Refills'}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {isAr
                  ? 'تقديرات محسوبة من كميات الصرف الأخيرة والجرعة اليومية المعتمدة'
                  : 'Calculated estimates based on last dispensed quantity and active schedule'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigateTo('refills')}
              className="text-xs font-semibold text-[#008C87] hover:underline inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>{isAr ? 'عرض الكل' : 'View all'}</span>
              <ArrowIcon className="w-3.5 h-3.5" />
            </button>
          </div>

          {urgentRefills.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">{t.common.noData}</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {urgentRefills.map((item) => (
                <div
                  key={item.medicationPlanId}
                  className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/70"
                >
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => navigateTo('patient-detail', item.patientId)}
                      className="text-sm font-bold text-[#103354] hover:text-[#008C87] text-start"
                    >
                      {item.patientName}{' '}
                      <span className="font-mono text-xs text-slate-500 font-normal">
                        · {item.patientCode}
                      </span>
                    </button>
                    <div className="text-xs text-slate-600 mt-0.5 truncate">
                      {item.medicationLabel}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {item.uncertaintyNote}
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                    <div className="text-end">
                      <div
                        className={`text-xs font-bold ${
                          item.refillStatus === 'overdue'
                            ? 'text-red-700'
                            : item.refillStatus === 'due_soon'
                              ? 'text-amber-700'
                              : item.refillStatus === 'unable_to_estimate' ||
                                  item.refillStatus === 'paused_or_prn'
                                ? 'text-slate-600'
                                : 'text-[#008C87]'
                        }`}
                      >
                        {t.refillStatus[item.refillStatus]}
                      </div>
                      <div className="text-xs text-slate-500 tabular-nums mt-0.5">
                        {item.estimatedSupplyEndDate
                          ? `${t.common.estimateLabel}: ${formatDate(item.estimatedSupplyEndDate, lang)}`
                          : t.refillStatus.unable_to_estimate}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigateTo('patient-detail', item.patientId)}
                      className="px-3 py-1.5 text-xs font-semibold text-[#103354] border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap"
                    >
                      {t.common.viewProfile}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right Column: Follow-ups + Recent Activity */}
        <div className="xl:col-span-5 space-y-6">
          {/* Priority Follow-ups */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-bold text-[#103354]">
                {isAr ? 'مهام المتابعة السريرية' : 'Clinical Follow-up Queue'}
              </h3>
              <button
                type="button"
                onClick={() => navigateTo('followups')}
                className="text-xs font-semibold text-[#008C87] hover:underline inline-flex items-center gap-1"
              >
                <span>{isAr ? 'إدارة المتابعات' : 'Manage'}</span>
                <ArrowIcon className="w-3.5 h-3.5" />
              </button>
            </div>
            {pendingFollowUps.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-500">{t.common.noData}</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {pendingFollowUps.map((fu) => {
                  const patient = state.patients.find((p) => p.id === fu.patientId);
                  return (
                    <div key={fu.id} className="px-5 py-3.5 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => navigateTo('patient-detail', fu.patientId)}
                          className="text-sm font-bold text-[#103354] hover:text-[#008C87]"
                        >
                          {patient?.fullName ?? '—'}
                        </button>
                        <span
                          className={`text-xs font-semibold tabular-nums ${
                            fu.status === 'overdue' ? 'text-red-700' : 'text-amber-700'
                          }`}
                        >
                          {t.followUpStatus[fu.status]} · {formatDate(fu.dueDate, lang)}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">{fu.notes}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent Activity / Audit Feed */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-bold text-[#103354]">
                {isAr ? 'آخر النشاطات في الصيدلية' : 'Recent Pharmacy Activity'}
              </h3>
              <button
                type="button"
                onClick={() => navigateTo('governance')}
                className="text-xs font-semibold text-[#008C87] hover:underline"
              >
                {isAr ? 'سجل التدقيق' : 'Audit Log'}
              </button>
            </div>
            <div className="divide-y divide-slate-100">
              {state.auditLogs.slice(0, 6).map((log) => {
                const display = getAuditLogDisplaySummary(log, lang);
                return (
                  <div key={log.id} className="px-5 py-3 text-xs space-y-1">
                    <div className="font-medium text-slate-900">{display.primaryText}</div>
                    {display.supportingDetail && (
                      <div dir="ltr" className="text-[11px] text-slate-500">
                        {display.supportingDetail}
                      </div>
                    )}
                    <div className="text-slate-500 flex items-center gap-2">
                      <span>{log.actorName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{formatDateTime(log.timestamp, lang)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <PatientFormModal
        isOpen={showAddPatient}
        onClose={() => setShowAddPatient(false)}
        onSaved={(patient) => navigateTo('patient-detail', patient.id)}
      />
    </div>
  );
};
