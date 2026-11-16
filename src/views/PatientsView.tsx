import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Search,
  UserPlus,
} from 'lucide-react';
import { PatientFormModal } from '../components/modals/PatientFormModal';
import { useCrm } from '../context/CrmContext';
import { calculateAge, formatDate, LABELS } from '../i18n/translations';
import { Patient } from '../types/domain';

export const PatientsView: React.FC = () => {
  const {
    lang,
    state,
    isConnectedMode,
    todayStr,
    refillProjections,
    navigateTo,
    archivePatient,
    restorePatient,
    pushToast,
  } = useCrm();
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [conditionFilter, setConditionFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'name' | 'code'>('newest');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingPatient, setEditingPatient] = useState<Patient | undefined>(undefined);
  const [busyPatientId, setBusyPatientId] = useState<string | null>(null);

  const allConditions = useMemo(() => {
    const set = new Set<string>();
    state.patients.forEach((p) => p.chronicConditions.forEach((c) => set.add(c)));
    return Array.from(set);
  }, [state.patients]);

  const filteredPatients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return state.patients
      .filter((p) => (statusFilter === 'all' ? true : p.status === statusFilter))
      .filter((p) =>
        conditionFilter === 'all' ? true : p.chronicConditions.includes(conditionFilter)
      )
      .filter((p) => {
        if (!q) return true;
        return (
          p.fullName.toLowerCase().includes(q) ||
          p.patientCode.toLowerCase().includes(q) ||
          p.phone.toLowerCase().includes(q) ||
          p.chronicConditions.some((c) => c.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => {
        if (sortBy === 'name') return a.fullName.localeCompare(b.fullName, lang);
        if (sortBy === 'code') return a.patientCode.localeCompare(b.patientCode);
        return b.registrationDate.localeCompare(a.registrationDate);
      });
  }, [state.patients, statusFilter, conditionFilter, searchQuery, sortBy, lang]);

  const ArrowIcon = isAr ? ChevronLeft : ChevronRight;

  return (
    <div className="space-y-5">
      {/* Top Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-[#103354]">
              {isAr ? 'سجل المرضى المزمنين' : 'Chronic Patient Directory'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {isConnectedMode
                ? isAr
                  ? 'التسجيل متاح حصراً للصيدلي المخول · سجلات الصيدلية المعزولة بـ RLS'
                  : 'Pharmacist-authorized registration only · Tenant-isolated PostgreSQL records'
                : isAr
                  ? 'التسجيل متاح حصراً للصيدلي المخول · بيانات تجريبية افتراضية'
                  : 'Pharmacist-authorized registration only · Stage 1 fictional dataset'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditingPatient(undefined);
              setShowAddModal(true);
            }}
            className="px-4 py-2.5 text-sm font-semibold text-white bg-[#103354] hover:bg-[#0B253E] rounded-lg inline-flex items-center justify-center gap-2 min-h-[42px] whitespace-nowrap"
          >
            <UserPlus className="w-4 h-4" />
            <span>{isAr ? 'إضافة مراجع جديد' : 'Add New Patient'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-5 relative">
            <Search className="w-4 h-4 text-slate-400 absolute top-3 start-3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                isAr
                  ? 'ابحث بالاسم، رقم الهاتف، رمز المراجع، أو المرض...'
                  : 'Search name, phone, ID, or condition...'
              }
              className="w-full ps-9 pe-3 py-2 text-sm border border-slate-300 rounded-lg focus:border-[#008C87] focus:outline-none"
            />
          </div>

          <div className="md:col-span-3">
            <select
              value={conditionFilter}
              onChange={(e) => setConditionFilter(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="all">{isAr ? 'جميع الحالات المزمنة' : 'All Conditions'}</option>
              {allConditions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'newest' | 'name' | 'code')}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="newest">{isAr ? 'الأحدث تسجيلاً' : 'Newest'}</option>
              <option value="name">{isAr ? 'الاسم أ-ي' : 'Name A-Z'}</option>
              <option value="code">{isAr ? 'رمز المراجع' : 'Patient ID'}</option>
            </select>
          </div>

          <div className="md:col-span-2 flex items-center p-1 bg-slate-100 rounded-lg">
            {(['active', 'archived', 'all'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  statusFilter === st
                    ? 'bg-white text-[#103354] shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {t.common[st]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Desktop Data Table */}
      <div className="hidden md:block bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filteredPatients.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">{t.common.noData}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-start">
              <thead className="bg-[#F5F7FA] border-b border-slate-200 text-xs font-semibold text-slate-600">
                <tr>
                  <th className="py-3 px-4 text-start">{isAr ? 'المراجع' : 'Patient'}</th>
                  <th className="py-3 px-4 text-start">{isAr ? 'الهاتف والعمر' : 'Phone & Age'}</th>
                  <th className="py-3 px-4 text-start">{isAr ? 'الحالات المزمنة' : 'Conditions'}</th>
                  <th className="py-3 px-4 text-start">{isAr ? 'الأدوية النشطة' : 'Active Meds'}</th>
                  <th className="py-3 px-4 text-start">{isAr ? 'أقرب إعادة صرف' : 'Next Refill'}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredPatients.map((patient) => {
                  const activeMedsCount = state.medicationPlans.filter(
                    (m) => m.patientId === patient.id && m.status === 'active'
                  ).length;
                  const nextRefill =
                    refillProjections.find(
                      (r) => r.patientId === patient.id && r.estimatedSupplyEndDate
                    ) ?? refillProjections.find((r) => r.patientId === patient.id);
                  return (
                    <tr
                      key={patient.id}
                      className="hover:bg-slate-50/80 transition-colors"
                    >
                      <td className="py-3.5 px-4">
                        <button
                          type="button"
                          onClick={() => navigateTo('patient-detail', patient.id)}
                          className="text-start group"
                        >
                          <div className="font-bold text-[#103354] group-hover:text-[#008C87] flex items-center gap-2">
                            <span>{patient.fullName}</span>
                            {patient.status === 'archived' && (
                              <span className="text-[11px] font-medium text-slate-500">
                                ({t.common.archived})
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2">
                            <span className="font-mono tabular-nums">{patient.patientCode}</span>
                            {patient.allergies.length > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-red-700 font-semibold inline-flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3" />
                                  {isAr
                                    ? `حساسية (${patient.allergies.length})`
                                    : `${patient.allergies.length} allergy`}
                                </span>
                              </>
                            )}
                          </div>
                        </button>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="font-mono text-xs tabular-nums text-slate-800" dir="ltr">
                          {patient.phone}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5 tabular-nums">
                          {calculateAge(patient.dateOfBirth, todayStr)} {t.common.years} ·{' '}
                          {patient.sex === 'female'
                            ? isAr
                              ? 'أنثى'
                              : 'Female'
                            : isAr
                              ? 'ذكر'
                              : 'Male'}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 max-w-xs">
                        <div className="text-xs text-slate-700">
                          {patient.chronicConditions.length > 0
                            ? patient.chronicConditions.join(isAr ? '، ' : ', ')
                            : '—'}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 tabular-nums font-semibold text-[#103354]">
                        {activeMedsCount}
                      </td>

                      <td className="py-3.5 px-4 text-xs tabular-nums">
                        {nextRefill ? (
                          <div>
                            <span
                              className={`font-semibold ${
                                nextRefill.refillStatus === 'overdue'
                                  ? 'text-red-700'
                                  : nextRefill.refillStatus === 'due_soon'
                                    ? 'text-amber-700'
                                    : nextRefill.refillStatus === 'unable_to_estimate' ||
                                        nextRefill.refillStatus === 'paused_or_prn'
                                      ? 'text-slate-600'
                                      : 'text-[#008C87]'
                              }`}
                            >
                              {nextRefill.estimatedSupplyEndDate
                                ? formatDate(nextRefill.estimatedSupplyEndDate, lang)
                                : t.refillStatus.unable_to_estimate}
                            </span>
                            <div className="text-[11px] text-slate-500">
                              {t.refillStatus[nextRefill.refillStatus]}
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => navigateTo('patient-detail', patient.id)}
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-[#103354] hover:bg-[#0B253E] rounded-lg inline-flex items-center gap-1"
                          >
                            <span>{t.common.viewProfile}</span>
                            <ArrowIcon className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingPatient(patient);
                              setShowAddModal(true);
                            }}
                            className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg"
                            title={t.common.edit}
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          {patient.status === 'active' ? (
                            <button
                              type="button"
                              disabled={busyPatientId === patient.id}
                              onClick={async () => {
                                setBusyPatientId(patient.id);
                                try {
                                  await archivePatient(
                                    patient.id,
                                    isAr ? 'أرشفة من دليل المرضى' : 'Archived from directory'
                                  );
                                  pushToast(
                                    isAr
                                      ? `تمت أرشفة ملف ${patient.fullName} مع حفظ السجل.`
                                      : `Archived ${patient.fullName}.`
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
                                  setBusyPatientId(null);
                                }
                              }}
                              className="p-2 text-slate-600 hover:bg-amber-50 hover:text-amber-800 disabled:opacity-50 rounded-lg"
                              title={isAr ? 'أرشفة' : 'Archive'}
                            >
                              <Archive className="w-4 h-4" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busyPatientId === patient.id}
                              onClick={async () => {
                                setBusyPatientId(patient.id);
                                try {
                                  await restorePatient(patient.id);
                                  pushToast(
                                    isAr
                                      ? `تمت استعادة ملف ${patient.fullName}.`
                                      : `Restored ${patient.fullName}.`
                                  );
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
                                  setBusyPatientId(null);
                                }
                              }}
                              className="p-2 text-[#008C87] hover:bg-teal-50 disabled:opacity-50 rounded-lg"
                              title={isAr ? 'استعادة' : 'Restore'}
                            >
                              <ArchiveRestore className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Mobile Cards List (Full Parity) */}
      <div className="md:hidden space-y-3">
        {filteredPatients.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
            {t.common.noData}
          </div>
        ) : (
          filteredPatients.map((patient) => {
            const activeMedsCount = state.medicationPlans.filter(
              (m) => m.patientId === patient.id && m.status === 'active'
            ).length;
            return (
              <div
                key={patient.id}
                className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-bold text-[#103354] text-base">{patient.fullName}</div>
                    <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap items-center gap-1.5 tabular-nums">
                      <span className="font-mono">{patient.patientCode}</span>
                      <span>·</span>
                      <span dir="ltr">{patient.phone}</span>
                      <span>·</span>
                      <span>
                        {calculateAge(patient.dateOfBirth, todayStr)} {t.common.years}
                      </span>
                    </div>
                  </div>
                  {patient.allergies.length > 0 && (
                    <span className="text-xs font-bold text-red-700 flex items-center gap-1 shrink-0">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {isAr ? 'حساسية' : 'Allergy'}
                    </span>
                  )}
                </div>

                {patient.chronicConditions.length > 0 && (
                  <div className="text-xs text-slate-600">
                    {patient.chronicConditions.join(isAr ? '، ' : ', ')}
                  </div>
                )}

                <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                  <span className="text-xs text-slate-500 tabular-nums">
                    {isAr ? `أدوية نشطة: ${activeMedsCount}` : `Active meds: ${activeMedsCount}`}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingPatient(patient);
                        setShowAddModal(true);
                      }}
                      className="p-2.5 text-slate-600 border border-slate-200 rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center"
                      aria-label={t.common.edit}
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateTo('patient-detail', patient.id)}
                      className="px-4 py-2.5 text-xs font-semibold text-white bg-[#103354] rounded-lg min-h-[44px]"
                    >
                      {t.common.viewProfile}
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {showAddModal && (
        <PatientFormModal
          isOpen={showAddModal}
          onClose={() => {
            setShowAddModal(false);
            setEditingPatient(undefined);
          }}
          existingPatient={editingPatient}
          onSaved={(saved) => {
            if (!editingPatient) navigateTo('patient-detail', saved.id);
          }}
        />
      )}
    </div>
  );
};
