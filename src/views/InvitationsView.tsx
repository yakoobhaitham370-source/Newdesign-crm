import React, { useMemo, useState } from 'react';
import { QrCode, RefreshCw, ShieldAlert, Smartphone, XCircle } from 'lucide-react';
import { InvitationModal } from '../components/modals/InvitationModal';
import { useCrm } from '../context/CrmContext';
import { formatDateTime, LABELS } from '../i18n/translations';
import { InvitationStatus, Patient } from '../types/domain';

export const InvitationsView: React.FC = () => {
  const { lang, state, isConnectedMode, navigateTo, issueInvitation, revokeInvitation, pushToast } =
    useCrm();
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const [filterStatus, setFilterStatus] = useState<InvitationStatus | 'all'>('all');
  const [modalPatient, setModalPatient] = useState<Patient | null>(null);

  const activePatients = useMemo(
    () => state.patients.filter((p) => p.status === 'active'),
    [state.patients]
  );

  const rows = useMemo(() => {
    return activePatients
      .map((patient) => {
        const inv = state.invitations.find((i) => i.patientId === patient.id);
        const status: InvitationStatus = inv?.status ?? 'not_invited';
        return { patient, inv, status };
      })
      .filter((row) => (filterStatus === 'all' ? true : row.status === filterStatus));
  }, [activePatients, state.invitations, filterStatus]);

  return (
    <div className="space-y-5">
      {/* Closed Registration Policy Notice */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 text-[#103354] shrink-0 mt-0.5" />
        <div className="space-y-1 text-xs text-slate-700">
          <div className="text-sm font-bold text-[#103354]">
            {isConnectedMode
              ? isAr
                ? 'إدارة دعوات تطبيق المريض (MASAR Patient APK) — بانتظار المرحلة 2C'
                : 'Patient APK Invitations — Pending Stage 2C'
              : isAr
                ? 'إدارة دعوات تطبيق المريض (MASAR Patient APK) — مرحلة ١ (MOCK)'
                : 'Patient APK Invitations — Stage 1 Mock Console'}
          </div>
          <p>
            {isAr
              ? 'القاعدة الإلزامية: لا يُسمح بتسجيل المرضى ذاتياً عبر التطبيق. يقوم الصيدلي المخول فقط بإنشاء سجل المريض وإصدار دعوة QR أو رابط تفعيل أحادي الاستخدام ومحدود الصلاحية.'
              : 'Mandatory policy: Public patient self-registration is disabled. Only authorized pharmacy staff can create patient records and issue single-use, expiring QR/link activation invitations.'}
          </p>
        </div>
      </div>

      {isConnectedMode && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-950 space-y-1">
          <div className="font-bold">
            {isAr
              ? 'تنبيه المرحلة 2C: إصدار وتفعيل وإلغاء دعوات المريض معطل في الوضع المتصل'
              : 'Stage 2C Readiness Notice: Patient Activation & Invitation Actions Disabled in Connected Mode'}
          </div>
          <p>
            {isAr
              ? 'توليد رموز QR القابلة للمسح، وإرسال SMS OTP، ووظائف استرداد الحساب الخادمية ستُفعّل في المرحلة 2C. تبقى أزرار الإصدار وإعادة الإصدار والإلغاء معطلة هنا لمنع التفعيل غير المكتمل.'
              : 'Scannable QR generation, SMS OTP dispatch, and recovery Edge Functions will be enabled in Stage 2C. Invite, Resend, and Revoke actions remain disabled in Connected Mode until Stage 2C.'}
          </p>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5 p-1 bg-slate-100 rounded-lg">
          {(['all', 'pending', 'activated', 'expired', 'revoked', 'not_invited'] as const).map(
            (st) => (
              <button
                key={st}
                type="button"
                onClick={() => setFilterStatus(st)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  filterStatus === st
                    ? 'bg-white text-[#103354] shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {st === 'all' ? t.common.all : t.invitationStatus[st]}
              </button>
            )
          )}
        </div>
      </div>

      {/* Invitations List */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">{t.common.noData}</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map(({ patient, inv, status }) => (
              <div
                key={patient.id}
                className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-50/70"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => navigateTo('patient-detail', patient.id)}
                      className="text-base font-bold text-[#103354] hover:text-[#008C87]"
                    >
                      {patient.fullName}
                    </button>
                    <span className="font-mono text-xs text-slate-500">{patient.patientCode}</span>
                    <span className="text-slate-300">·</span>
                    <span
                      className={`text-xs font-bold ${
                        status === 'activated'
                          ? 'text-[#008C87]'
                          : status === 'pending'
                            ? 'text-amber-700'
                            : status === 'expired' || status === 'revoked'
                              ? 'text-red-700'
                              : 'text-slate-500'
                      }`}
                    >
                      {t.invitationStatus[status]}
                    </span>
                  </div>

                  {inv ? (
                    <div className="text-xs text-slate-500 flex flex-wrap gap-3 tabular-nums">
                      <span className="font-mono">{inv.mockInviteCode}</span>
                      <span>·</span>
                      <span>
                        {isAr ? 'صدرت:' : 'Issued:'} {formatDateTime(inv.issuedAt, lang)}
                      </span>
                      <span>·</span>
                      <span>
                        {isAr ? 'تنتهي:' : 'Expires:'} {formatDateTime(inv.expiresAt, lang)}
                      </span>
                      {inv.deviceLabel && (
                        <>
                          <span>·</span>
                          <span className="text-[#008C87] font-medium">{inv.deviceLabel}</span>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">
                      {isAr
                        ? 'لم تُنشأ دعوة لهذا المراجع بعد.'
                        : 'No invitation issued for this patient yet.'}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setModalPatient(patient)}
                    className="px-3.5 py-2 text-xs font-semibold text-white bg-[#103354] hover:bg-[#0B253E] rounded-lg inline-flex items-center gap-1.5 min-h-[40px]"
                  >
                    {isConnectedMode ? (
                      <>
                        <Smartphone className="w-3.5 h-3.5" />
                        <span>
                          {isAr ? 'عرض الحالة (بانتظار 2C)' : 'Status (Stage 2C Pending)'}
                        </span>
                      </>
                    ) : status === 'not_invited' ? (
                      <>
                        <Smartphone className="w-3.5 h-3.5" />
                        <span>{isAr ? 'إصدار دعوة' : 'Invite Patient'}</span>
                      </>
                    ) : (
                      <>
                        <QrCode className="w-3.5 h-3.5" />
                        <span>{isAr ? 'معاينة QR والرابط' : 'QR & Link Preview'}</span>
                      </>
                    )}
                  </button>

                  {status !== 'not_invited' && status !== 'activated' && (
                    <button
                      type="button"
                      disabled={isConnectedMode}
                      onClick={() => {
                        void issueInvitation(patient.id, 'dob_and_phone_otp')
                          .then(() => {
                            pushToast(
                              isAr
                                ? status === 'pending'
                                  ? `تم إلغاء الدعوة السابقة وإصدار دعوة جديدة للمراجع ${patient.fullName}.`
                                  : `تمت إعادة إرسال الدعوة للمراجع ${patient.fullName}.`
                                : status === 'pending'
                                  ? `Superseded pending invite and re-issued invitation for ${patient.fullName}.`
                                  : `Re-issued invitation for ${patient.fullName}.`
                            );
                          })
                          .catch((err) => {
                            pushToast(
                              err instanceof Error ? err.message : 'Failed to re-issue invitation.',
                              'error'
                            );
                          });
                      }}
                      className="px-3 py-2 text-xs font-semibold text-[#008C87] border border-teal-200 bg-teal-50 rounded-lg hover:bg-teal-100 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1 min-h-[40px]"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>{isAr ? 'إعادة إصدار' : 'Resend'}</span>
                    </button>
                  )}

                  {status === 'pending' && (
                    <button
                      type="button"
                      disabled={isConnectedMode}
                      onClick={() => {
                        void revokeInvitation(patient.id)
                          .then(() => {
                            pushToast(isAr ? 'تم إلغاء الدعوة.' : 'Invitation revoked.', 'warning');
                          })
                          .catch((err) => {
                            pushToast(
                              err instanceof Error ? err.message : 'Failed to revoke invitation.',
                              'error'
                            );
                          });
                      }}
                      className="px-3 py-2 text-xs font-semibold text-red-700 border border-red-200 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1 min-h-[40px]"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      <span>{isAr ? 'إلغاء' : 'Revoke'}</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {modalPatient && (
        <InvitationModal
          isOpen={true}
          onClose={() => setModalPatient(null)}
          patient={modalPatient}
        />
      )}
    </div>
  );
};
