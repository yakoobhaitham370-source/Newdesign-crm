/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertCircle, LogOut, RefreshCw } from 'lucide-react';
import { PharmacistLoginScreen } from './components/auth/PharmacistLoginScreen';
import { AppShell } from './components/layout/AppShell';
import { CrmProvider, useCrm } from './context/CrmContext';
import { AnalyticsView } from './views/AnalyticsView';
import { ConsultationsView } from './views/ConsultationsView';
import { DashboardView } from './views/DashboardView';
import { DispensingView } from './views/DispensingView';
import { FollowUpsView } from './views/FollowUpsView';
import { GovernanceView } from './views/GovernanceView';
import { InvitationsView } from './views/InvitationsView';
import { PatientDetailView } from './views/PatientDetailView';
import { PatientsView } from './views/PatientsView';
import { RefillsView } from './views/RefillsView';

const ActiveViewRenderer: React.FC = () => {
  const { activeNav } = useCrm();

  switch (activeNav) {
    case 'dashboard':
      return <DashboardView />;
    case 'patients':
      return <PatientsView />;
    case 'patient-detail':
      return <PatientDetailView />;
    case 'dispensing':
      return <DispensingView />;
    case 'refills':
      return <RefillsView />;
    case 'invitations':
      return <InvitationsView />;
    case 'followups':
      return <FollowUpsView />;
    case 'consultations':
      return <ConsultationsView />;
    case 'analytics':
      return <AnalyticsView />;
    case 'governance':
      return <GovernanceView />;
    default:
      return <DashboardView />;
  }
};

const ConnectedModeGate: React.FC = () => {
  const {
    lang,
    toggleLang,
    isConnectedMode,
    authStatus,
    authError,
    hasUnauthorizedSession,
    signIn,
    signOut,
    retrySession,
    state,
    isLoading,
    asyncError,
    refreshState,
  } = useCrm();

  const isAr = lang === 'ar';

  if (isConnectedMode) {
    if (authStatus === 'checking') {
      return (
        <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center p-6">
          <div className="bg-white border border-slate-200 rounded-xl px-6 py-5 text-sm text-[#103354] font-semibold">
            {isAr
              ? 'جاري التحقق من جلسة الصيدلي وصلاحيات الصيدلية...'
              : 'Verifying authenticated pharmacist session...'}
          </div>
        </div>
      );
    }

    if (
      authStatus === 'unauthenticated' ||
      authStatus === 'unauthorized' ||
      authStatus === 'connection_error' ||
      authStatus === 'config_error'
    ) {
      return (
        <PharmacistLoginScreen
          lang={lang}
          onToggleLang={toggleLang}
          authStatus={authStatus}
          authError={authError}
          hasUnauthorizedSession={hasUnauthorizedSession}
          onSignIn={signIn}
          onSignOut={signOut}
          onRetrySession={retrySession}
        />
      );
    }

    if (!state.pharmacy.id && isLoading) {
      return (
        <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center p-6">
          <div className="bg-white border border-slate-200 rounded-xl px-6 py-5 text-sm text-[#103354] font-semibold">
            {isAr
              ? 'جاري تحميل سجلات الصيدلية الموثقة...'
              : 'Loading authoritative pharmacy records...'}
          </div>
        </div>
      );
    }

    if (!state.pharmacy.id) {
      return (
        <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white border border-red-200 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3 text-red-800">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h1 className="text-base font-bold">
                  {isAr ? 'تعذر تحميل بيانات الصيدلية' : 'Failed to Load Pharmacy Records'}
                </h1>
                <p className="text-xs text-red-700">
                  {asyncError ??
                    (isAr
                      ? 'تعذر التحقق من بيانات الصيدلية في الخادم. يرجى إعادة المحاولة.'
                      : 'Authoritative pharmacy state could not be loaded. Please retry.')}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                onClick={() => void signOut()}
                className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>{isAr ? 'تسجيل الخروج' : 'Sign Out'}</span>
              </button>
              <button
                type="button"
                onClick={() => void refreshState()}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#103354] hover:bg-[#0B253E] rounded-lg inline-flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>{isAr ? 'إعادة المحاولة' : 'Retry'}</span>
              </button>
            </div>
          </div>
        </div>
      );
    }
  }

  return (
    <AppShell>
      <ActiveViewRenderer />
    </AppShell>
  );
};

export default function App() {
  return (
    <CrmProvider>
      <ConnectedModeGate />
    </CrmProvider>
  );
}
