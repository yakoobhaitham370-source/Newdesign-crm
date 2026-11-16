import React, { useMemo, useState } from 'react';
import { CheckCircle2, Search, Send, ShieldCheck } from 'lucide-react';
import { useCrm } from '../context/CrmContext';
import { formatDateTime, LABELS } from '../i18n/translations';
import { isVerifiedPharmacistApproval } from '../services/consultationApproval';
import { ConsultationStatus } from '../types/domain';

export const ConsultationsView: React.FC = () => {
  const {
    lang,
    state,
    navigateTo,
    sendConsultationReply,
    updateConsultationStatus,
    pushToast,
  } = useCrm();
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ConsultationStatus | 'all'>('all');
  const [selectedThreadId, setSelectedThreadId] = useState<string>(
    state.consultations[0]?.id ?? ''
  );
  const [replyText, setReplyText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  const filteredThreads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return state.consultations
      .filter((c) => (statusFilter === 'all' ? true : c.status === statusFilter))
      .filter((c) => {
        if (!q) return true;
        const patient = state.patients.find((p) => p.id === c.patientId);
        return (
          c.subject.toLowerCase().includes(q) ||
          patient?.fullName.toLowerCase().includes(q) ||
          c.messages.some((m) => m.body.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [state.consultations, state.patients, statusFilter, searchQuery]);

  const activeThread =
    filteredThreads.find((c) => c.id === selectedThreadId) ?? filteredThreads[0];
  const activePatient = activeThread
    ? state.patients.find((p) => p.id === activeThread.patientId)
    : undefined;

  const quickTemplates = isAr
    ? [
        'أهلاً بك، يُؤخذ الدواء بعد الطعام مع كوب ماء كامل.',
        'العلاج متوفر حالياً في الصيدلية، يمكنك الاستلام أو حجز إعادة الصرف.',
        'يرجى عدم تعديل الجرعة إلا بعد مراجعة قراءاتك معنا أو مع الطبيب المعالج.',
      ]
    : [
        'Take this medication after food with a full glass of water.',
        'Medication is available at the pharmacy for pickup.',
        'Do not adjust your dose before reviewing with your pharmacist or physician.',
      ];

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSending || !activeThread || !replyText.trim()) return;
    setIsSending(true);
    try {
      await sendConsultationReply(activeThread.id, replyText.trim(), 'follow_up');
      setReplyText('');
      pushToast(
        isAr
          ? 'تم إرسال الرد الصيدلاني المعتمد.'
          : 'Pharmacist-approved response sent.'
      );
    } catch (err) {
      pushToast(
        err instanceof Error
          ? err.message
          : isAr
            ? 'تعذر إرسال الرد.'
            : 'Unable to send reply.',
        'error'
      );
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      {/* Left: Inbox List */}
      <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 space-y-3">
          <h2 className="text-base font-bold text-[#103354]">
            {isAr ? 'صندوق الاستشارات الصيدلانية' : 'Consultation Inbox'}
          </h2>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute top-2.5 start-3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.common.search}
              className="w-full ps-9 pe-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
          </div>
          <div className="flex gap-1 p-1 bg-slate-100 rounded-lg">
            {(['all', 'open', 'follow_up', 'resolved'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`flex-1 py-1 text-[11px] font-semibold rounded ${
                  statusFilter === st ? 'bg-white text-[#103354] shadow-xs' : 'text-slate-600'
                }`}
              >
                {st === 'all' ? t.common.all : t.consultationStatus[st]}
              </button>
            ))}
          </div>
        </div>

        <div className="divide-y divide-slate-100 max-h-[540px] overflow-y-auto">
          {filteredThreads.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">{t.common.noData}</div>
          ) : (
            filteredThreads.map((thread) => {
              const pat = state.patients.find((p) => p.id === thread.patientId);
              const isSelected = activeThread?.id === thread.id;
              return (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => setSelectedThreadId(thread.id)}
                  className={`w-full p-4 text-start transition-colors ${
                    isSelected ? 'bg-teal-50/60' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold text-[#103354] truncate">
                      {pat?.fullName ?? '—'}
                    </span>
                    <span
                      className={`text-[11px] font-semibold shrink-0 ${
                        thread.status === 'open'
                          ? 'text-amber-700'
                          : thread.status === 'resolved'
                            ? 'text-[#008C87]'
                            : 'text-[#103354]'
                      }`}
                    >
                      {t.consultationStatus[thread.status]}
                    </span>
                  </div>
                  <div className="text-xs font-medium text-slate-700 mt-0.5 truncate">
                    {thread.subject}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 truncate">
                    {thread.messages[thread.messages.length - 1]?.body}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right: Active Conversation & Approved Response Editor */}
      <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col min-h-[540px]">
        {!activeThread ? (
          <div className="flex-1 flex items-center justify-center p-8 text-sm text-slate-500">
            {t.common.noData}
          </div>
        ) : (
          <>
            <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <button
                  type="button"
                  onClick={() => activePatient && navigateTo('patient-detail', activePatient.id)}
                  className="text-base font-bold text-[#103354] hover:text-[#008C87]"
                >
                  {activePatient?.fullName ?? '—'}
                </button>
                <div className="text-xs text-slate-500">{activeThread.subject}</div>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={activeThread.status}
                  disabled={isUpdatingStatus}
                  onChange={async (e) => {
                    const nextStatus = e.target.value as ConsultationStatus;
                    setIsUpdatingStatus(true);
                    try {
                      await updateConsultationStatus(activeThread.id, nextStatus);
                    } catch (err) {
                      pushToast(
                        err instanceof Error
                          ? err.message
                          : isAr
                            ? 'تعذر تحديث حالة الاستشارة.'
                            : 'Unable to update consultation status.',
                        'error'
                      );
                    } finally {
                      setIsUpdatingStatus(false);
                    }
                  }}
                  className="px-3 py-1.5 text-xs font-semibold border border-slate-300 rounded-lg bg-white disabled:opacity-50"
                >
                  <option value="open">{t.consultationStatus.open}</option>
                  <option value="follow_up">{t.consultationStatus.follow_up}</option>
                  <option value="resolved">{t.consultationStatus.resolved}</option>
                </select>
              </div>
            </div>

            <div className="px-5 py-2.5 bg-[#F5F7FA] border-b border-slate-200 text-[11px] text-slate-600 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-[#008C87] shrink-0" />
              <span>
                {isAr
                  ? 'لا يتم إرسال أي نصيحة سريرية تلقائياً — جميع الردود تراجع وتعتمد من الصيدلي المناوب.'
                  : 'No automated clinical advice is sent — all responses require direct pharmacist approval.'}
              </span>
            </div>

            <div className="flex-1 p-5 space-y-3 overflow-y-auto max-h-[340px]">
              {activeThread.messages.map((msg) => {
                const isPharm = msg.senderType === 'pharmacist';
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col max-w-[85%] ${
                      isPharm ? 'ms-auto items-end' : 'me-auto items-start'
                    }`}
                  >
                    <div
                      className={`px-4 py-3 rounded-xl text-sm ${
                        isPharm
                          ? 'bg-[#103354] text-white'
                          : 'bg-[#F5F7FA] border border-slate-200 text-slate-800'
                      }`}
                    >
                      <p>{msg.body}</p>
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1.5 tabular-nums">
                      <span>{msg.senderName}</span>
                      <span>·</span>
                      <span>{formatDateTime(msg.sentAt, lang)}</span>
                      {isVerifiedPharmacistApproval(msg) && (
                        <CheckCircle2 className="w-3 h-3 text-[#008C87]" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <form onSubmit={handleSend} className="p-4 border-t border-slate-200 bg-slate-50 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {quickTemplates.map((tpl, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setReplyText(tpl)}
                    className="px-2.5 py-1 text-[11px] bg-white border border-slate-300 rounded-lg text-slate-700 hover:border-[#008C87] text-start"
                  >
                    {tpl}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder={
                    isAr ? 'اكتب ردك الصيدلاني المعتمد...' : 'Write pharmacist-approved reply...'
                  }
                  className="flex-1 px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:border-[#008C87] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={isSending || replyText.trim().length === 0}
                  className="px-4 py-2.5 text-sm font-semibold text-white bg-[#008C87] hover:bg-[#00736F] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg inline-flex items-center gap-1.5 shrink-0"
                >
                  <Send className="w-4 h-4" />
                  <span>{isAr ? 'إرسال' : 'Send'}</span>
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
};
