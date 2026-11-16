import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  X,
  XCircle,
} from 'lucide-react';
import { useCrm } from '../../context/CrmContext';
import { formatDateTime, LABELS } from '../../i18n/translations';
import { Patient } from '../../types/domain';
import { QrPreview } from '../ui/QrPreview';

interface InvitationModalProps {
  isOpen: boolean;
  onClose: () => void;
  patient: Patient;
}

export const InvitationModal: React.FC<InvitationModalProps> = ({ isOpen, onClose, patient }) => {
  const {
    lang,
    state,
    isConnectedMode,
    issueInvitation,
    revokeInvitation,
    simulateInvitationActivation,
    simulateInvitationExpiry,
    pushToast,
  } = useCrm();
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const [verifyMethod, setVerifyMethod] = useState<'dob_and_phone_otp' | 'national_id_last4'>(
    'dob_and_phone_otp'
  );
  const [confirmReplaceActivated, setConfirmReplaceActivated] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const invitation = state.invitations.find((i) => i.patientId === patient.id);
  const status = invitation?.status ?? 'not_invited';

  const handleCopy = (text: string) => {
    navigator.clipboard?.writeText(text);
    pushToast(
      isConnectedMode
        ? isAr
          ? 'تم نسخ رمز التفعيل.'
          : 'Activation token copied.'
        : isAr
          ? 'تم نسخ رابط التفعيل التجريبي.'
          : 'Mock activation link copied.'
    );
  };

  const handleIssue = async () => {
    if (isSubmitting) return;
    if (status === 'activated' && !confirmReplaceActivated) {
      pushToast(
        isAr
          ? 'المراجع لديه جهاز مُفعّل مسبقاً — يرجى تأكيد خيار استبدال الجهاز أولاً.'
          : 'Patient is already activated — please confirm device replacement first.',
        'warning'
      );
      return;
    }
    setIsSubmitting(true);
    try {
      await issueInvitation(patient.id, verifyMethod);
      setConfirmReplaceActivated(false);
      pushToast(
        isAr
          ? status === 'pending'
            ? 'تم إلغاء الدعوة السابقة وإصدار دعوة جديدة.'
            : 'تم إصدار دعوة جديدة لتطبيق المريض.'
          : status === 'pending'
            ? 'Previous pending invitation superseded; new invitation issued.'
            : 'Issued new APK invitation.'
      );
    } catch (err) {
      pushToast(
        err instanceof Error
          ? err.message
          : isAr
            ? 'تعذر إصدار الدعوة.'
            : 'Failed to issue invitation.',
        'error'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRevoke = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await revokeInvitation(patient.id);
      pushToast(isAr ? 'تم إلغاء الدعوة.' : 'Invitation revoked.', 'warning');
    } catch (err) {
      pushToast(
        err instanceof Error
          ? err.message
          : isAr
            ? 'تعذر إلغاء الدعوة.'
            : 'Failed to revoke invitation.',
        'error'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invitation-modal-title"
    >
      <div className="bg-white w-full h-full sm:h-auto sm:max-h-[92vh] sm:max-w-xl sm:rounded-xl border border-slate-200 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2.5">
            <Smartphone className="w-5 h-5 text-[#008C87]" />
            <div>
              <h2 id="invitation-modal-title" className="text-lg font-bold text-[#103354]">
                {isAr ? 'دعوة تفعيل تطبيق المريض (APK)' : 'Patient APK Invitation'}
              </h2>
              <p className="text-xs text-slate-500">
                {patient.fullName} · <span className="font-mono">{patient.patientCode}</span>
              </p>
            </div>
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

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Mandatory Policy Banner */}
          <div className="p-3 bg-[#F5F7FA] border border-slate-200 rounded-lg text-xs text-slate-700 flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-[#103354] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold text-[#103354]">
                {isAr
                  ? 'سياسة التسجيل المغلق: الصيدلي فقط يصدر الدعوات'
                  : 'Closed Onboarding Policy: Pharmacist-Issued Only'}
              </p>
              <p>
                {isConnectedMode
                  ? isAr
                    ? 'لا يمكن للمريض إنشاء حساب مستقل. إصدار وتفعيل دعوات تطبيق المريض في الوضع المتصل معطل حالياً حتى المرحلة 2C.'
                    : 'Patients cannot self-register. Connected Mode APK invitation issuance and activation are disabled until Stage 2C.'
                  : isAr
                    ? 'لا يمكن للمريض إنشاء حساب مستقل. هذه معاينة تجريبية للمرحلة ١ (MOCK)؛ التفعيل الحقيقي في المرحلة ٢ يتطلب رمزاً خادمياً أحادي الاستخدام والتحقق من هوية المريض.'
                    : 'Patients cannot self-register. Stage 1 uses MOCK invitations only; Stage 2 requires single-use server-side tokens and patient identity verification.'}
              </p>
            </div>
          </div>

          {isConnectedMode && (
            <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-950 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-bold">
                  {isAr
                    ? 'جاهزية المرحلة 2C: تفعيل تطبيق المريض غير مفعّل في الوضع المتصل'
                    : 'Stage 2C Readiness Guard: Patient Activation Disabled in Connected Mode'}
                </p>
                <p>
                  {isAr
                    ? 'توليد رموز QR القابلة للمسح، وإرسال رموز SMS OTP، ووظائف الاسترداد الخادمية مجدولة للمرحلة 2C. تبقى أزرار الإصدار والإلغاء ورموز التسليم معطلة لمنع أي تفعيل غير مكتمل.'
                    : 'Scannable QR generation, SMS OTP delivery, and recovery Edge Functions are scheduled for Stage 2C. Issuance, revocation, QR previews, and handover secret fields remain disabled in Connected Mode.'}
                </p>
              </div>
            </div>
          )}

          {/* Current Status */}
          <div className="flex items-center justify-between p-3.5 border border-slate-200 rounded-xl">
            <span className="text-xs font-semibold text-slate-600">
              {isAr ? 'حالة الدعوة الحالية:' : 'Current Invitation Status:'}
            </span>
            <span
              className={`text-xs font-bold ${
                status === 'activated'
                  ? 'text-[#008C87]'
                  : status === 'pending'
                    ? 'text-amber-700'
                    : status === 'revoked' || status === 'expired'
                      ? 'text-red-700'
                      : 'text-slate-600'
              }`}
            >
              {t.invitationStatus[status]}
            </span>
          </div>

          {/* Identity Verification Method */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              {isAr
                ? 'طريقة التحقق من هوية المراجع عند التفعيل (المرحلة ٢)'
                : 'Identity Verification Requirement (Stage 2)'}
            </label>
            <select
              value={verifyMethod}
              disabled={isConnectedMode || isSubmitting}
              onChange={(e) =>
                setVerifyMethod(e.target.value as 'dob_and_phone_otp' | 'national_id_last4')
              }
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed"
            >
              <option value="dob_and_phone_otp">
                {isAr
                  ? 'تاريخ الميلاد + رمز التحقق على الهاتف (OTP)'
                  : 'Date of Birth + Phone OTP'}
              </option>
              <option value="national_id_last4">
                {isAr
                  ? 'تاريخ الميلاد + آخر ٤ أرقام من البطاقة الوطنية'
                  : 'Date of Birth + National ID Last 4'}
              </option>
            </select>
          </div>

          {invitation && status !== 'not_invited' && (
            <div className="p-4 border border-slate-200 rounded-xl bg-[#F5F7FA] space-y-4">
              <div className="flex flex-col sm:flex-row items-center gap-4">
                {!isConnectedMode && (
                  <QrPreview
                    value={invitation.mockInviteCode}
                    size={140}
                    label={`Mock QR ${invitation.mockInviteCode}`}
                  />
                )}
                <div className="flex-1 space-y-2 text-xs w-full">
                  <div className="font-bold text-[#103354]">
                    {isConnectedMode
                      ? isAr
                        ? 'بيانات الدعوة المخزنة (قراءة فقط — بانتظار المرحلة 2C)'
                        : 'Stored Invitation Metadata (Read-Only — Pending Stage 2C)'
                      : isAr
                        ? 'معاينة رمز QR التجريبي (MOCK)'
                        : 'Mock QR & Activation Link'}
                  </div>
                  <p className="text-slate-600">
                    {isAr ? 'تاريخ الإصدار:' : 'Issued:'}{' '}
                    <span className="tabular-nums">{formatDateTime(invitation.issuedAt, lang)}</span>
                  </p>
                  <p className="text-slate-600">
                    {isAr ? 'تنتهي الصلاحية:' : 'Expires:'}{' '}
                    <span className="tabular-nums">{formatDateTime(invitation.expiresAt, lang)}</span>
                  </p>
                  {invitation.activatedAt && (
                    <p className="text-[#008C87] font-semibold">
                      {isAr ? 'تم التفعيل:' : 'Activated:'}{' '}
                      <span className="tabular-nums">
                        {formatDateTime(invitation.activatedAt, lang)}
                      </span>
                      {invitation.deviceLabel ? ` · ${invitation.deviceLabel}` : ''}
                    </p>
                  )}
                  {!isConnectedMode && invitation.mockActivationUrl && (
                    <div className="pt-1">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          readOnly
                          dir="ltr"
                          value={invitation.mockActivationUrl}
                          className="flex-1 px-2.5 py-1.5 text-[11px] font-mono bg-white border border-slate-300 rounded-lg text-slate-700"
                        />
                        <button
                          type="button"
                          onClick={() => handleCopy(invitation.mockActivationUrl)}
                          className="p-2 bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
                          title={isAr ? 'نسخ' : 'Copy'}
                        >
                          <Copy className="w-4 h-4 text-slate-700" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Stage 1 Lifecycle Simulation Controls (hidden in Connected Mode) */}
              {!isConnectedMode && status === 'pending' && (
                <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-500">
                    {isAr
                      ? 'محاكاة دورة حياة الدعوة (المرحلة ١):'
                      : 'Stage 1 Lifecycle Simulation:'}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => {
                        void simulateInvitationActivation(patient.id)
                          .then(() => {
                            pushToast(
                              isAr ? 'تمت محاكاة تفعيل حساب المراجع.' : 'Simulated patient activation.'
                            );
                          })
                          .catch((err) => {
                            pushToast(
                              err instanceof Error ? err.message : 'Simulation failed.',
                              'error'
                            );
                          });
                      }}
                      className="px-2.5 py-1 text-[11px] font-semibold bg-teal-50 text-[#008C87] border border-teal-200 rounded hover:bg-teal-100 inline-flex items-center gap-1"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{isAr ? 'محاكاة التفعيل' : 'Simulate Activate'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => {
                        void simulateInvitationExpiry(patient.id)
                          .then(() => {
                            pushToast(
                              isAr ? 'تمت محاكاة انتهاء صلاحية الدعوة.' : 'Simulated expiry.',
                              'warning'
                            );
                          })
                          .catch((err) => {
                            pushToast(
                              err instanceof Error ? err.message : 'Simulation failed.',
                              'error'
                            );
                          });
                      }}
                      className="px-2.5 py-1 text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200 rounded hover:bg-amber-100"
                    >
                      {isAr ? 'محاكاة انتهاء الصلاحية' : 'Simulate Expire'}
                    </button>
                  </div>
                </div>
              )}

              {status === 'activated' && (
                <div className="pt-3 border-t border-slate-200">
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-950 space-y-2">
                    <div className="flex items-start gap-2 font-semibold">
                      <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                      <span>
                        {isAr
                          ? 'تحذير ربط مكرر: هذا المراجع فعّل حسابه مسبقاً على جهاز مرتبط.'
                          : 'Duplicate Link Guard: This patient already has an activated device.'}
                      </span>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer font-medium">
                      <input
                        type="checkbox"
                        disabled={isConnectedMode}
                        checked={confirmReplaceActivated}
                        onChange={(e) => setConfirmReplaceActivated(e.target.checked)}
                        className="w-4 h-4 accent-[#103354] disabled:cursor-not-allowed"
                      />
                      <span>
                        {isAr
                          ? 'أؤكد إلغاء ربط الجهاز السابق وإصدار دعوة استبدال جديدة'
                          : 'Confirm replacing existing device and issuing a new single-use invitation'}
                      </span>
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
          <div>
            {status === 'pending' && (
              <button
                type="button"
                disabled={isConnectedMode || isSubmitting}
                onClick={() => void handleRevoke()}
                className="px-3.5 py-2 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5 min-h-[40px]"
              >
                <XCircle className="w-4 h-4" />
                <span>{isAr ? 'إلغاء الدعوة' : 'Revoke Invitation'}</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 min-h-[40px]"
            >
              {t.common.close}
            </button>
            <button
              type="button"
              disabled={isConnectedMode || isSubmitting}
              onClick={() => void handleIssue()}
              className="px-4 py-2 text-sm font-semibold text-white bg-[#103354] hover:bg-[#0B253E] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg inline-flex items-center gap-1.5 min-h-[40px]"
            >
              <RefreshCw className="w-4 h-4" />
              <span>
                {isConnectedMode
                  ? isAr
                    ? 'معطل حتى المرحلة 2C'
                    : 'Disabled Until Stage 2C'
                  : status === 'not_invited'
                    ? isAr
                      ? 'إصدار دعوة وتوليد QR'
                      : 'Issue Mock Invitation'
                    : isAr
                      ? 'إعادة إصدار دعوة جديدة'
                      : 'Resend / Re-issue'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
