import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ClipboardCheck, Phone, Plus } from 'lucide-react';
import { useCrm } from '../context/CrmContext';
import { formatDate, formatDateTime, LABELS } from '../i18n/translations';
import { ContactOutcome, FollowUpStatus, FollowUpType } from '../types/domain';

export const FollowUpsView: React.FC = () => {
  const {
    lang,
    state,
    todayStr,
    navigateTo,
    addFollowUp,
    updateFollowUpStatus,
    addFollowUpContactLog,
    pushToast,
  } = useCrm();
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const [statusFilter, setStatusFilter] = useState<FollowUpStatus | 'all'>('all');
  const [showCreateForm, setShowCreateForm] = useState(false);

  const activePatients = useMemo(
    () => state.patients.filter((p) => p.status === 'active'),
    [state.patients]
  );

  const [newPatientId, setNewPatientId] = useState(activePatients[0]?.id ?? '');
  const effectiveNewPatientId = activePatients.some((p) => p.id === newPatientId)
    ? newPatientId
    : (activePatients[0]?.id ?? '');
  const [newType, setNewType] = useState<FollowUpType>('clinical');
  const [newDueDate, setNewDueDate] = useState(todayStr);
  const prevTodayRef = useRef(todayStr);
  const [newNotes, setNewNotes] = useState('');

  useEffect(() => {
    if (newDueDate === prevTodayRef.current) {
      setNewDueDate(todayStr);
    }
    prevTodayRef.current = todayStr;
  }, [todayStr, newDueDate]);

  // Contact log form per task
  const [activeLogTaskId, setActiveLogTaskId] = useState<string | null>(null);
  const [logOutcome, setLogOutcome] = useState<ContactOutcome>('answered');
  const [logChannel, setLogChannel] = useState<'whatsapp_manual' | 'phone_call' | 'in_pharmacy'>(
    'phone_call'
  );
  const [logSummary, setLogSummary] = useState('');
  const [isSubmittingTask, setIsSubmittingTask] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const filteredTasks = useMemo(() => {
    return state.followUps
      .filter((f) => (statusFilter === 'all' ? true : f.status === statusFilter))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }, [state.followUps, statusFilter]);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingTask) return;
    if (!effectiveNewPatientId || !newNotes.trim()) {
      pushToast(isAr ? 'اختر المراجع واكتب ملاحظة المتابعة.' : 'Select patient and enter notes.', 'error');
      return;
    }
    setIsSubmittingTask(true);
    try {
      await addFollowUp({
        patientId: effectiveNewPatientId,
        type: newType,
        dueDate: newDueDate,
        status: 'pending',
        notes: newNotes.trim(),
        assignedStaffName:
          state.staff.find((s) => s.id === state.activeStaffId)?.fullName ??
          state.staff[0]?.fullName ??
          '',
      });
      setNewNotes('');
      setShowCreateForm(false);
      pushToast(isAr ? 'تم إنشاء مهمة متابعة سريرية.' : 'Follow-up task created.');
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
      setIsSubmittingTask(false);
    }
  };

  const handleSaveContactLog = async (taskId: string) => {
    if (busyTaskId) return;
    if (logSummary.trim().length < 2) {
      pushToast(
        isAr
          ? 'اكتب ملخص التواصل (حرفين على الأقل).'
          : 'Enter contact summary (at least 2 characters).',
        'error'
      );
      return;
    }
    setBusyTaskId(taskId);
    try {
      await addFollowUpContactLog(taskId, {
        channel: logChannel,
        outcome: logOutcome,
        summary: logSummary.trim(),
      });
      setLogSummary('');
      setActiveLogTaskId(null);
      pushToast(isAr ? 'تم توثيق سجل التواصل.' : 'Contact log recorded.');
    } catch (err) {
      pushToast(
        err instanceof Error
          ? err.message
          : isAr
            ? 'تعذر حفظ سجل التواصل.'
            : 'Unable to save contact log.',
        'error'
      );
    } finally {
      setBusyTaskId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-[#103354]">
            {isAr ? 'المتابعات السريرية وسجل التواصل' : 'Clinical Follow-ups & Contact History'}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {isAr
              ? 'التواصل عبر واتساب يتم يدوياً فقط بواسطة الصيدلي دون أي إرسال آلي لمعلومات المريض الصحية.'
              : 'WhatsApp outreach is strictly manual; no automated transmission of patient medical data occurs.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 p-1 bg-slate-100 rounded-lg">
            {(['all', 'overdue', 'pending', 'completed'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md ${
                  statusFilter === st ? 'bg-white text-[#103354] shadow-xs' : 'text-slate-600'
                }`}
              >
                {st === 'all' ? t.common.all : t.followUpStatus[st]}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowCreateForm((v) => !v)}
            className="px-4 py-2 text-xs font-semibold text-white bg-[#103354] hover:bg-[#0B253E] rounded-lg inline-flex items-center gap-1.5 min-h-[38px]"
          >
            <Plus className="w-4 h-4" />
            <span>{isAr ? 'مهمة متابعة جديدة' : 'New Follow-up'}</span>
          </button>
        </div>
      </div>

      {showCreateForm && (
        <form
          onSubmit={handleCreateTask}
          className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 sm:grid-cols-4 gap-3"
        >
          <select
            value={effectiveNewPatientId}
            onChange={(e) => setNewPatientId(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
          >
            {activePatients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName} ({p.patientCode})
              </option>
            ))}
          </select>
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as FollowUpType)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
          >
            {(Object.keys(t.followUpTypes) as FollowUpType[]).map((ft) => (
              <option key={ft} value={ft}>
                {t.followUpTypes[ft]}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={newDueDate}
            onChange={(e) => setNewDueDate(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums"
          />
          <input
            type="text"
            value={newNotes}
            onChange={(e) => setNewNotes(e.target.value)}
            placeholder={isAr ? 'سبب وملاحظات المتابعة...' : 'Follow-up notes...'}
            className="sm:col-span-3 px-3 py-2 text-sm border border-slate-300 rounded-lg"
          />
          <button
            type="submit"
            disabled={isSubmittingTask}
            className="px-4 py-2 text-sm font-semibold text-white bg-[#008C87] disabled:opacity-50 rounded-lg"
          >
            {t.common.save}
          </button>
        </form>
      )}

      <div className="space-y-4">
        {filteredTasks.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
            {t.common.noData}
          </div>
        ) : (
          filteredTasks.map((task) => {
            const patient = state.patients.find((p) => p.id === task.patientId);
            return (
              <div
                key={task.id}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => patient && navigateTo('patient-detail', patient.id)}
                        className="text-base font-bold text-[#103354] hover:text-[#008C87]"
                      >
                        {patient?.fullName ?? '—'}
                      </button>
                      <span className="text-xs text-slate-500">· {t.followUpTypes[task.type]}</span>
                      <span className="text-xs text-slate-500">·</span>
                      <span
                        className={`text-xs font-bold tabular-nums ${
                          task.status === 'overdue'
                            ? 'text-red-700'
                            : task.status === 'completed'
                              ? 'text-[#008C87]'
                              : 'text-amber-700'
                        }`}
                      >
                        {t.followUpStatus[task.status]} ({formatDate(task.dueDate, lang)})
                      </span>
                    </div>
                    <p className="text-sm text-slate-700">{task.notes}</p>
                    <div className="text-xs text-slate-500">
                      {isAr ? 'المسؤول:' : 'Assigned:'} {task.assignedStaffName}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {patient && (
                      <a
                        href={`https://wa.me/964${patient.phone.replace(/^0/, '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-2 text-xs font-semibold text-[#008C87] border border-teal-200 bg-teal-50/50 hover:bg-teal-50 rounded-lg inline-flex items-center gap-1.5"
                      >
                        <Phone className="w-3.5 h-3.5" />
                        <span>{isAr ? 'واتساب يدوي' : 'Manual WhatsApp'}</span>
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setActiveLogTaskId(activeLogTaskId === task.id ? null : task.id)
                      }
                      className="px-3 py-2 text-xs font-semibold text-[#103354] border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5"
                    >
                      <ClipboardCheck className="w-3.5 h-3.5" />
                      <span>{isAr ? 'توثيق تواصل' : 'Log Contact'}</span>
                    </button>
                    {task.status !== 'completed' && (
                      <button
                        type="button"
                        disabled={busyTaskId === task.id}
                        onClick={async () => {
                          setBusyTaskId(task.id);
                          try {
                            await updateFollowUpStatus(task.id, 'completed');
                            pushToast(isAr ? 'تم إغلاق مهمة المتابعة.' : 'Follow-up completed.');
                          } catch (err) {
                            pushToast(
                              err instanceof Error
                                ? err.message
                                : isAr
                                  ? 'تعذر إكمال المهمة.'
                                  : 'Unable to complete follow-up.',
                              'error'
                            );
                          } finally {
                            setBusyTaskId(null);
                          }
                        }}
                        className="px-3 py-2 text-xs font-semibold text-white bg-[#008C87] hover:bg-[#00736F] disabled:opacity-50 rounded-lg inline-flex items-center gap-1.5"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{isAr ? 'إكمال' : 'Complete'}</span>
                      </button>
                    )}
                  </div>
                </div>

                {activeLogTaskId === task.id && (
                  <div className="p-3.5 bg-[#F5F7FA] border border-slate-200 rounded-lg grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                    <select
                      value={logChannel}
                      onChange={(e) =>
                        setLogChannel(
                          e.target.value as 'whatsapp_manual' | 'phone_call' | 'in_pharmacy'
                        )
                      }
                      className="px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    >
                      <option value="phone_call">{isAr ? 'اتصال هاتفي' : 'Phone Call'}</option>
                      <option value="whatsapp_manual">
                        {isAr ? 'واتساب يدوي' : 'Manual WhatsApp'}
                      </option>
                      <option value="in_pharmacy">
                        {isAr ? 'زيارة في الصيدلية' : 'In-Pharmacy Visit'}
                      </option>
                    </select>
                    <select
                      value={logOutcome}
                      onChange={(e) => setLogOutcome(e.target.value as ContactOutcome)}
                      className="px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    >
                      {(Object.keys(t.contactOutcomes) as ContactOutcome[]).map((oc) => (
                        <option key={oc} value={oc}>
                          {t.contactOutcomes[oc]}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={logSummary}
                      onChange={(e) => setLogSummary(e.target.value)}
                      placeholder={isAr ? 'ملخص نتيجة التواصل...' : 'Contact outcome notes...'}
                      className="sm:col-span-2 px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                    />
                    <div className="sm:col-span-4 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveLogTaskId(null)}
                        className="px-3 py-1.5 text-xs text-slate-600"
                      >
                        {t.common.cancel}
                      </button>
                      <button
                        type="button"
                        disabled={busyTaskId === task.id}
                        onClick={() => void handleSaveContactLog(task.id)}
                        className="px-4 py-1.5 text-xs font-semibold text-white bg-[#103354] disabled:opacity-50 rounded-lg"
                      >
                        {isAr ? 'حفظ السجل' : 'Save Log'}
                      </button>
                    </div>
                  </div>
                )}

                {task.contactHistory.length > 0 && (
                  <div className="pt-2 border-t border-slate-100 space-y-1.5">
                    <div className="text-[11px] font-semibold text-slate-500">
                      {isAr ? 'سجل التواصل السابق:' : 'Contact History:'}
                    </div>
                    {task.contactHistory.map((ch) => (
                      <div key={ch.id} className="text-xs text-slate-600 flex flex-wrap gap-2">
                        <span className="font-semibold text-[#103354]">
                          {t.contactOutcomes[ch.outcome]}
                        </span>
                        <span>·</span>
                        <span>{ch.summary}</span>
                        <span className="text-slate-400 tabular-nums">
                          ({ch.staffName} · {formatDateTime(ch.contactedAt, lang)})
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
