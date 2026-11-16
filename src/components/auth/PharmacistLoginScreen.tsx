import React, { useState } from 'react';
import {
  Activity,
  AlertCircle,
  Globe,
  Lock,
  LogOut,
  Mail,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { LABELS } from '../../i18n/translations';
import { Language } from '../../types/domain';

interface PharmacistLoginScreenProps {
  lang: Language;
  onToggleLang: () => void;
  authStatus: 'unauthenticated' | 'unauthorized' | 'connection_error' | 'config_error';
  authError: string | null;
  hasUnauthorizedSession?: boolean;
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignOut?: () => Promise<void>;
  onRetrySession?: () => Promise<void>;
}

export const PharmacistLoginScreen: React.FC<PharmacistLoginScreenProps> = ({
  lang,
  onToggleLang,
  authStatus,
  authError,
  hasUnauthorizedSession = false,
  onSignIn,
  onSignOut,
  onRetrySession,
}) => {
  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || authStatus === 'config_error') return;

    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      setLocalError(
        isAr
          ? 'يرجى إدخال البريد الإلكتروني وكلمة المرور.'
          : 'Please enter both email and password.'
      );
      return;
    }

    setLocalError(null);
    setSubmitting(true);
    try {
      await onSignIn(cleanEmail, password);
    } catch (err) {
      setLocalError(
        err instanceof Error
          ? err.message
          : isAr
            ? 'تعذر تسجيل الدخول.'
            : 'Unable to sign in.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const displayedError = localError ?? authError;

  return (
    <div className="min-h-screen bg-[#F5F7FA] text-slate-900 flex flex-col justify-between p-4 sm:p-6">
      <div className="max-w-md w-full mx-auto pt-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-[#103354] text-white flex items-center justify-center">
            <Activity className="w-5 h-5 text-[#00D1C7]" />
          </div>
          <div>
            <div className="text-base font-bold text-[#103354]">{t.brandName}</div>
            <div className="text-[11px] text-slate-500">
              {isAr ? 'بيئة الصيدلي المتصلة (Supabase)' : 'Pharmacist Connected CRM'}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onToggleLang}
          className="px-3 py-1.5 text-xs font-semibold text-[#103354] bg-white hover:bg-slate-100 border border-slate-200 rounded-lg inline-flex items-center gap-1.5 min-h-[38px]"
        >
          <Globe className="w-3.5 h-3.5 text-[#008C87]" />
          <span>{lang === 'ar' ? 'English' : 'العربية'}</span>
        </button>
      </div>

      <main className="max-w-md w-full mx-auto my-auto py-8">
        <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
          <div className="space-y-1.5">
            <h1 className="text-xl font-bold text-[#103354]">
              {isAr ? 'تسجيل دخول الصيدلي المخول' : 'Authorized Pharmacist Sign In'}
            </h1>
            <p className="text-xs text-slate-500">
              {isAr
                ? 'الدخول مقصور على كوادر الصيدلية المسجلين والمفعلين عبر Supabase Auth.'
                : 'Access is restricted to active registered pharmacy staff verified via Supabase Auth.'}
            </p>
          </div>

          {displayedError && (
            <div
              role="alert"
              className={`p-3.5 border rounded-lg text-xs flex items-start gap-2.5 ${
                authStatus === 'connection_error'
                  ? 'bg-amber-50 border-amber-200 text-amber-950'
                  : 'bg-red-50 border-red-200 text-red-900'
              }`}
            >
              <AlertCircle
                className={`w-4 h-4 shrink-0 mt-0.5 ${
                  authStatus === 'connection_error' ? 'text-amber-700' : 'text-red-700'
                }`}
              />
              <div className="space-y-1">
                <div className="font-semibold">
                  {authStatus === 'config_error'
                    ? isAr
                      ? 'خطأ في إعدادات الاتصال'
                      : 'Configuration Error'
                    : authStatus === 'connection_error'
                      ? isAr
                        ? 'تعذر التحقق من الاتصال بقاعدة البيانات'
                        : 'Connection Verification Failed'
                      : authStatus === 'unauthorized'
                        ? isAr
                          ? 'حساب غير مخول'
                          : 'Unauthorized Account'
                        : isAr
                          ? 'تعذر تسجيل الدخول'
                          : 'Sign-In Failed'}
                </div>
                <p>{displayedError}</p>
              </div>
            </div>
          )}

          {authStatus === 'connection_error' && onRetrySession && (
            <button
              type="button"
              onClick={() => void onRetrySession()}
              className="w-full py-2.5 px-4 text-sm font-semibold text-[#103354] bg-amber-50 hover:bg-amber-100 border border-amber-300 rounded-lg inline-flex items-center justify-center gap-2 min-h-[42px]"
            >
              <RefreshCw className="w-4 h-4" />
              <span>
                {isAr
                  ? 'إعادة التحقق من الجلسة والاتصال'
                  : 'Retry Session Verification'}
              </span>
            </button>
          )}

          {hasUnauthorizedSession && onSignOut && (
            <button
              type="button"
              onClick={() => void onSignOut()}
              className="w-full py-2.5 px-4 text-sm font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg inline-flex items-center justify-center gap-2 min-h-[42px]"
            >
              <LogOut className="w-4 h-4" />
              <span>
                {authStatus === 'connection_error'
                  ? isAr
                    ? 'تسجيل الخروج من الجلسة الحالية'
                    : 'Sign Out Current Session'
                  : isAr
                    ? 'تسجيل الخروج واستخدام حساب صيدلي مخول'
                    : 'Sign Out & Switch to Authorized Pharmacist'}
              </span>
            </button>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="pharmacist-login-email"
                className="block text-xs font-semibold text-slate-700 mb-1.5"
              >
                {isAr ? 'البريد الإلكتروني للصيدلي' : 'Pharmacist Email'}
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute top-3 start-3" />
                <input
                  id="pharmacist-login-email"
                  type="email"
                  dir="ltr"
                  autoComplete="email"
                  disabled={authStatus === 'config_error' || submitting}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="pharmacist@pharmacy.example"
                  className="w-full ps-9 pe-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:border-[#008C87] focus:outline-none disabled:bg-slate-100"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="pharmacist-login-password"
                className="block text-xs font-semibold text-slate-700 mb-1.5"
              >
                {isAr ? 'كلمة المرور' : 'Password'}
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute top-3 start-3" />
                <input
                  id="pharmacist-login-password"
                  type="password"
                  dir="ltr"
                  autoComplete="current-password"
                  disabled={authStatus === 'config_error' || submitting}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full ps-9 pe-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:border-[#008C87] focus:outline-none disabled:bg-slate-100"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={authStatus === 'config_error' || submitting}
              className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-[#103354] hover:bg-[#0B253E] disabled:opacity-50 rounded-lg transition-colors min-h-[44px]"
            >
              {submitting
                ? isAr
                  ? 'جاري التحقق من الصلاحية...'
                  : 'Verifying staff credentials...'
                : isAr
                  ? 'تسجيل الدخول إلى النظام'
                  : 'Sign In to Pharmacy CRM'}
            </button>
          </form>

          <div className="p-3.5 bg-[#F5F7FA] border border-slate-200 rounded-lg text-xs text-slate-600 flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-[#008C87] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-bold text-[#103354]">
                {isAr ? 'نظام مغلق بدون تسجيل ذاتي' : 'Closed Invite-Only Staff Access'}
              </div>
              <p>
                {isAr
                  ? 'لا يتوفر إنشاء حسابات عامة. تتم إضافة الصيادلة حصراً بواسطة مالك الصيدلية عبر المسار الخادمي الموثق، وتبقى بيانات كل صيدلية معزولة على مستوى قاعدة البيانات.'
                  : 'Public self-registration is disabled. Pharmacy staff accounts are provisioned exclusively by the pharmacy owner, with strict database-level tenant isolation.'}
              </p>
            </div>
          </div>
        </div>
      </main>

      <footer className="max-w-md w-full mx-auto text-center text-[11px] text-slate-500 pb-2">
        {t.common.baghdadTz} · Option B Tenant-Isolated CRM
      </footer>
    </div>
  );
};
