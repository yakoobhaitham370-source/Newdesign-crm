import React, { useMemo } from 'react';
import { BarChart3, Info } from 'lucide-react';
import { useCrm } from '../context/CrmContext';
import { calculateAge, LABELS } from '../i18n/translations';

export const AnalyticsView: React.FC = () => {
  const { lang, state, todayStr, refillProjections } = useCrm();
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const activePatients = useMemo(
    () => state.patients.filter((p) => p.status === 'active'),
    [state.patients]
  );

  // 1. Age distribution computed live
  const ageBuckets = useMemo(() => {
    const buckets = [
      { label: isAr ? 'أقل من ٣٠ سنة' : 'Under 30', count: 0 },
      { label: isAr ? '٣٠ – ٥٠ سنة' : '30 – 50 yrs', count: 0 },
      { label: isAr ? '٥١ – ٦٥ سنة' : '51 – 65 yrs', count: 0 },
      { label: isAr ? 'فوق ٦٥ سنة' : 'Over 65 yrs', count: 0 },
    ];
    activePatients.forEach((p) => {
      const age = calculateAge(p.dateOfBirth, todayStr);
      if (age < 30) buckets[0].count++;
      else if (age <= 50) buckets[1].count++;
      else if (age <= 65) buckets[2].count++;
      else buckets[3].count++;
    });
    return buckets;
  }, [activePatients, isAr, todayStr]);

  // 2. Chronic condition prevalence computed live
  const conditionCounts = useMemo(() => {
    const map = new Map<string, number>();
    activePatients.forEach((p) => {
      p.chronicConditions.forEach((c) => {
        map.set(c, (map.get(c) ?? 0) + 1);
      });
    });
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [activePatients]);

  // 3. Most commonly dispensed medicines
  const topDispensedMeds = useMemo(() => {
    const map = new Map<string, { label: string; count: number; totalQty: number; unit: string }>();
    state.dispensingEvents.forEach((evt) => {
      const plan = state.medicationPlans.find((m) => m.id === evt.medicationPlanId);
      const key = plan ? `${plan.brandName} ${plan.strength}` : evt.medicationPlanId;
      const cur = map.get(key) ?? {
        label: key,
        count: 0,
        totalQty: 0,
        unit: evt.quantityUnit,
      };
      cur.count += 1;
      cur.totalQty += evt.dispensedQuantity;
      map.set(key, cur);
    });
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [state.dispensingEvents, state.medicationPlans]);

  // 4. Monthly dispensing activity
  const monthlyDispensing = useMemo(() => {
    const map = new Map<string, number>();
    state.dispensingEvents.forEach((evt) => {
      const ym = evt.dispensingDate.slice(0, 7); // YYYY-MM
      map.set(ym, (map.get(ym) ?? 0) + 1);
    });
    return Array.from(map.entries())
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [state.dispensingEvents]);

  // 5. Refill status distribution
  const refillStats = useMemo(() => {
    return [
      {
        label: t.refillStatus.overdue,
        count: refillProjections.filter((r) => r.refillStatus === 'overdue').length,
        color: 'bg-red-600',
      },
      {
        label: t.refillStatus.due_soon,
        count: refillProjections.filter((r) => r.refillStatus === 'due_soon').length,
        color: 'bg-amber-600',
      },
      {
        label: t.refillStatus.upcoming,
        count: refillProjections.filter((r) => r.refillStatus === 'upcoming').length,
        color: 'bg-[#103354]',
      },
      {
        label: t.refillStatus.on_track,
        count: refillProjections.filter((r) => r.refillStatus === 'on_track').length,
        color: 'bg-[#008C87]',
      },
      {
        label: t.refillStatus.unable_to_estimate,
        count: refillProjections.filter(
          (r) => r.refillStatus === 'unable_to_estimate' || r.refillStatus === 'paused_or_prn'
        ).length,
        color: 'bg-slate-500',
      },
    ];
  }, [refillProjections, t]);

  // 6. Patient-confirmed dose adherence stats (strictly separate from dispensing!)
  const adherenceSummary = useMemo(() => {
    const total = state.doseEvents.length;
    const taken = state.doseEvents.filter((d) => d.status === 'taken').length;
    const delayed = state.doseEvents.filter((d) => d.status === 'delayed').length;
    const pending = state.doseEvents.filter((d) => d.status === 'pending_unconfirmed').length;
    const skipped = state.doseEvents.filter((d) => d.status === 'skipped_by_patient').length;
    return { total, taken, delayed, pending, skipped };
  }, [state.doseEvents]);

  const maxAge = Math.max(1, ...ageBuckets.map((b) => b.count));
  const maxCond = Math.max(1, ...conditionCounts.map((c) => c.count));
  const maxMonth = Math.max(1, ...monthlyDispensing.map((m) => m.count));

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex items-start gap-3">
        <Info className="w-5 h-5 text-[#008C87] shrink-0 mt-0.5" />
        <div>
          <h2 className="text-lg font-bold text-[#103354]">
            {isAr
              ? 'التحليلات السريرية والتشغيلية (بيانات عرض تجريبية)'
              : 'Clinical & Pharmacy Analytics (Demonstration Data)'}
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            {isAr
              ? 'جميع الرسوم البيانية التالية محسوبة تلقائياً من السجلات الافتراضية للمرحلة ١ لأغراض العرض والتوضيح فقط.'
              : 'All charts below are computed dynamically from the fictional Stage 1 dataset for demonstration purposes only.'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Age Distribution */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-[#103354]">
              {isAr ? 'توزيع الفئات العمرية للمراجعين' : 'Patient Age Distribution'}
            </h3>
            <span className="text-xs text-slate-500 tabular-nums">
              {activePatients.length} {isAr ? 'مراجع نشط' : 'active'}
            </span>
          </div>
          <div className="space-y-3">
            {ageBuckets.map((b) => (
              <div key={b.label} className="space-y-1">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-slate-700">{b.label}</span>
                  <span className="font-mono font-bold text-[#103354] tabular-nums">{b.count}</span>
                </div>
                <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#103354] rounded-full"
                    style={{ width: `${(b.count / maxAge) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Chronic Disease Distribution */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h3 className="text-base font-bold text-[#103354]">
            {isAr ? 'توزيع الأمراض المزمنة المسجلة' : 'Chronic Condition Distribution'}
          </h3>
          <div className="space-y-3">
            {conditionCounts.map((c) => (
              <div key={c.name} className="space-y-1">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-slate-700">{c.name}</span>
                  <span className="font-mono font-bold text-[#008C87] tabular-nums">{c.count}</span>
                </div>
                <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#008C87] rounded-full"
                    style={{ width: `${(c.count / maxCond) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Most Commonly Dispensed Medications */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h3 className="text-base font-bold text-[#103354]">
            {isAr ? 'الأدوية الأكثر صرفاً' : 'Most Commonly Dispensed Medicines'}
          </h3>
          <div className="divide-y divide-slate-100">
            {topDispensedMeds.map((med, idx) => (
              <div key={med.label} className="py-2.5 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2.5">
                  <span className="w-6 h-6 rounded-md bg-[#F5F7FA] border border-slate-200 flex items-center justify-center font-mono font-bold text-[#103354]">
                    {idx + 1}
                  </span>
                  <span className="font-semibold text-slate-800">{med.label}</span>
                </div>
                <div className="tabular-nums text-slate-600">
                  <strong className="text-[#103354]">{med.count}</strong>{' '}
                  {isAr ? 'عمليات صرف' : 'dispenses'} · {med.totalQty} {med.unit}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Monthly Dispensing Activity */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-[#103354]">
              {isAr ? 'النشاط الشهري لصرف الأدوية' : 'Monthly Dispensing Activity'}
            </h3>
            <BarChart3 className="w-4 h-4 text-[#008C87]" />
          </div>
          <div className="space-y-3">
            {monthlyDispensing.map((m) => (
              <div key={m.month} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="font-mono text-slate-700 tabular-nums">{m.month}</span>
                  <span className="font-mono font-bold text-[#103354] tabular-nums">
                    {m.count} {isAr ? 'عملية' : 'events'}
                  </span>
                </div>
                <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#008C87] rounded-full"
                    style={{ width: `${(m.count / maxMonth) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Refill & Follow-up Trends */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h3 className="text-base font-bold text-[#103354]">
            {isAr ? 'توزيع حالة إعادة الصرف والمراجعات' : 'Refill & Follow-up Status Overview'}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {refillStats.map((st) => (
              <div key={st.label} className="p-3 bg-[#F5F7FA] border border-slate-200 rounded-lg">
                <div className="text-xs text-slate-600">{st.label}</div>
                <div className="text-2xl font-bold text-[#103354] tabular-nums mt-1">{st.count}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Adherence Reporting (Separate from Dispensing) */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div>
            <h3 className="text-base font-bold text-[#103354]">
              {isAr
                ? 'تقارير تأكيد الجرعات (تطبيق المريض التجريبي)'
                : 'Patient-Confirmed Adherence Reporting (Demo)'}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {isAr
                ? 'منفصلة كلياً عن سجلات الصرف؛ الجرعات غير المؤكدة لا تُحتسب فائتة تلقائياً.'
                : 'Strictly separate from dispensing logs; unconfirmed doses are not counted as skipped.'}
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div className="p-3 bg-teal-50/70 border border-teal-200 rounded-lg">
              <div className="text-xl font-bold text-[#008C87] tabular-nums">
                {adherenceSummary.taken}
              </div>
              <div className="text-[11px] text-slate-700 mt-0.5">
                {isAr ? 'مؤكد الأخذ' : 'Taken'}
              </div>
            </div>
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="text-xl font-bold text-amber-700 tabular-nums">
                {adherenceSummary.delayed}
              </div>
              <div className="text-[11px] text-slate-700 mt-0.5">
                {isAr ? 'متأخر' : 'Delayed'}
              </div>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-xl font-bold text-slate-700 tabular-nums">
                {adherenceSummary.pending}
              </div>
              <div className="text-[11px] text-slate-700 mt-0.5">
                {isAr ? 'بانتظار التأكيد' : 'Unconfirmed'}
              </div>
            </div>
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
              <div className="text-xl font-bold text-red-700 tabular-nums">
                {adherenceSummary.skipped}
              </div>
              <div className="text-[11px] text-slate-700 mt-0.5">
                {isAr ? 'تجاوز صريح' : 'Skipped'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
