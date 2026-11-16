import React, { useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  Bell,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Pill,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Users,
  X,
} from 'lucide-react';
import { NavSection, useCrm } from '../../context/CrmContext';
import { formatDate, LABELS } from '../../i18n/translations';

interface AppShellProps {
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const {
    lang,
    toggleLang,
    activeNav,
    navigateTo,
    state,
    kpis,
    todayStr,
    clockMode,
    demoClockAllowed,
    setClockMode,
    isConnectedMode,
    authenticatedPharmacist,
    signOut,
    asyncError,
    clearAsyncError,
    setActiveStaffId,
    resetDemoData,
    toasts,
    dismissToast,
  } = useCrm();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileMenuOpen]);

  const isAr = lang === 'ar';
  const t = LABELS[lang];

  const openConsultationsCount = state.consultations.filter((c) => c.status === 'open').length;

  const navItems: Array<{
    id: NavSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badgeCount?: number;
  }> = [
    { id: 'dashboard', label: t.nav.dashboard, icon: LayoutDashboard },
    { id: 'patients', label: t.nav.patients, icon: Users },
    { id: 'dispensing', label: t.nav.dispensing, icon: Pill },
    {
      id: 'refills',
      label: t.nav.refills,
      icon: CalendarClock,
      badgeCount: kpis.refillsDueSoonCount,
    },
    { id: 'invitations', label: t.nav.invitations, icon: Smartphone },
    {
      id: 'followups',
      label: t.nav.followups,
      icon: ClipboardCheck,
      badgeCount: kpis.patientsRequiringFollowUp,
    },
    {
      id: 'consultations',
      label: t.nav.consultations,
      icon: MessageSquare,
      badgeCount: openConsultationsCount,
    },
    { id: 'analytics', label: t.nav.analytics, icon: BarChart3 },
    { id: 'governance', label: t.nav.governance, icon: ShieldCheck },
  ];

  const currentNavLabel =
    activeNav === 'patient-detail'
      ? isAr
        ? 'ملف المراجع'
        : 'Patient Profile'
      : navItems.find((n) => n.id === activeNav)?.label ?? t.nav.dashboard;

  const handleNavClick = (id: NavSection) => {
    navigateTo(id, id === 'patient-detail' ? undefined : null);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#F5F7FA] text-slate-900 flex flex-col lg:flex-row">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 bg-white border-e border-slate-200 sticky top-0 h-screen">
        {/* Brand Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#103354] text-white flex items-center justify-center shrink-0">
            <Activity className="w-5 h-5 text-[#00D1C7]" />
          </div>
          <div className="min-w-0">
            <div className="text-base font-bold text-[#103354] tracking-tight whitespace-nowrap">
              {t.brandName}
            </div>
            <div className="text-[11px] text-slate-500 truncate">{t.brandTagline}</div>
          </div>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1" aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              activeNav === item.id || (activeNav === 'patient-detail' && item.id === 'patients');
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors min-h-[42px] ${
                  isActive
                    ? 'bg-[#103354] text-white'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-[#103354]'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon
                    className={`w-4 h-4 shrink-0 ${isActive ? 'text-[#00D1C7]' : 'text-slate-500'}`}
                  />
                  <span className="truncate whitespace-nowrap">{item.label}</span>
                </span>
                {item.badgeCount !== undefined && item.badgeCount > 0 && (
                  <span
                    className={`text-xs font-mono tabular-nums px-1.5 py-0.5 rounded ${
                      isActive ? 'bg-white/15 text-white' : 'text-amber-700 font-bold'
                    }`}
                  >
                    {item.badgeCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* PRODUCTION BOUNDARY (Stage 2B): Before connecting live Supabase Auth/CRM,
            remove this demo staff switcher (`setActiveStaffId`) and `Reset Demo Data`
            control, deriving operator identity strictly from `auth.uid()` -> `pharmacy_staff`. */}
        {/* Pharmacy & Staff Switcher */}
        <div className="p-4 border-t border-slate-200 bg-slate-50/70 space-y-2.5">
          <div className="text-xs">
            <div className="font-bold text-[#103354] truncate">
              {isAr ? state.pharmacy.nameAr : state.pharmacy.nameEn}
            </div>
            <div className="text-slate-500 truncate mt-0.5">
              {state.pharmacy.city} · {formatDate(todayStr, lang)}
            </div>
          </div>
          {isConnectedMode ? (
            <div className="space-y-2">
              <div className="p-2.5 bg-white border border-slate-200 rounded-lg text-xs space-y-0.5">
                <div className="text-[11px] text-slate-500">
                  {isAr ? 'الصيدلي الموثق:' : 'Authenticated Operator:'}
                </div>
                <div className="font-bold text-[#103354] truncate">
                  {authenticatedPharmacist?.staff.fullName ?? state.staff[0]?.fullName ?? '—'}
                </div>
                {authenticatedPharmacist && (
                  <div className="text-[11px] text-[#008C87] font-semibold">
                    {t.roles[authenticatedPharmacist.role]}
                  </div>
                )}
              </div>
              <div className="w-full py-1.5 px-2.5 text-[11px] font-medium text-[#103354] bg-white border border-slate-200 rounded-lg flex items-center justify-between gap-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-[#008C87]" />
                  <span>{isAr ? 'توقيت بغداد الحي' : 'Live Baghdad Time'}</span>
                </span>
                <span className="font-mono text-[10px] text-slate-500 tabular-nums">{todayStr}</span>
              </div>
              <button
                type="button"
                onClick={() => void signOut()}
                className="w-full py-1.5 px-2.5 text-[11px] font-semibold text-red-700 hover:bg-red-50 border border-red-200 rounded-lg flex items-center justify-center gap-1.5 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>{isAr ? 'تسجيل الخروج' : 'Sign Out'}</span>
              </button>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isAr ? 'الصيدلي المناوب:' : 'Active Pharmacist:'}
                </label>
                <select
                  value={state.activeStaffId}
                  onChange={(e) => setActiveStaffId(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-800"
                >
                  {state.staff.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.fullName} ({t.roles[st.role]})
                    </option>
                  ))}
                </select>
              </div>
              {demoClockAllowed ? (
                <button
                  type="button"
                  onClick={() =>
                    setClockMode(clockMode === 'live_baghdad' ? 'fixed_fixture' : 'live_baghdad')
                  }
                  className="w-full py-1.5 px-2.5 text-[11px] font-medium text-[#103354] bg-white border border-slate-200 hover:bg-slate-100 rounded-lg flex items-center justify-between gap-1.5 transition-colors"
                  title={
                    isAr
                      ? 'التبديل بين التوقيت الحي لبغداد وتاريخ العرض التجريبي الثابت'
                      : 'Switch between live Baghdad clock and fixed demo fixture date'
                  }
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-[#008C87]" />
                    <span>
                      {clockMode === 'live_baghdad'
                        ? isAr
                          ? 'الساعة: بغداد الحي'
                          : 'Clock: Live Baghdad'
                        : isAr
                          ? 'وضع العرض: ١٢/١١'
                          : 'Demo Fixture: Nov 12'}
                    </span>
                  </span>
                  <span className="font-mono text-[10px] text-slate-500 tabular-nums">{todayStr}</span>
                </button>
              ) : (
                <div className="w-full py-1.5 px-2.5 text-[11px] font-medium text-[#103354] bg-white border border-slate-200 rounded-lg flex items-center justify-between gap-1.5">
                  <span className="inline-flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-[#008C87]" />
                    <span>{isAr ? 'توقيت بغداد الحي' : 'Live Baghdad Time'}</span>
                  </span>
                  <span className="font-mono text-[10px] text-slate-500 tabular-nums">{todayStr}</span>
                </div>
              )}
              <button
                type="button"
                onClick={resetDemoData}
                className="w-full py-1.5 px-2.5 text-[11px] font-medium text-slate-600 hover:text-[#103354] hover:bg-slate-200/60 rounded-lg flex items-center justify-center gap-1.5 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{t.common.resetDemo}</span>
              </button>
            </>
          )}
        </div>
      </aside>

      {/* Main Content Wrapper */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header Bar (Clean 3-zone contract) */}
        <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-4 lg:px-8 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ms-2 rounded-lg text-slate-700 hover:bg-slate-100 min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 min-w-0">
              <span className="lg:hidden font-bold text-[#103354] text-sm whitespace-nowrap">
                {t.brandName}
              </span>
              <span className="lg:hidden text-slate-300">/</span>
              <h1 className="text-sm sm:text-base font-bold text-[#103354] truncate whitespace-nowrap">
                {currentNavLabel}
              </h1>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-2 text-xs text-slate-500 whitespace-nowrap">
            <span>
              {isConnectedMode
                ? isAr
                  ? 'بيئة تطوير متصلة · Supabase RLS'
                  : 'Connected Dev · Supabase RLS'
                : t.prototypeBadge}
            </span>
            <span aria-hidden="true">·</span>
            <span>{t.common.baghdadTz}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums font-medium text-[#103354]">
              {clockMode === 'live_baghdad'
                ? isAr
                  ? `حي (${formatDate(todayStr, lang)})`
                  : `Live (${formatDate(todayStr, lang)})`
                : isAr
                  ? `عرض ثابت (${formatDate(todayStr, lang)})`
                  : `Demo Fixed (${formatDate(todayStr, lang)})`}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => handleNavClick('refills')}
              className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 relative min-h-[40px] min-w-[40px] flex items-center justify-center"
              title={t.nav.refills}
              aria-label={t.nav.refills}
            >
              <Bell className="w-4 h-4" />
              {kpis.refillsDueSoonCount > 0 && (
                <span className="absolute top-1.5 end-1.5 w-2 h-2 rounded-full bg-amber-600" />
              )}
            </button>
            <button
              type="button"
              onClick={toggleLang}
              className="px-3 py-1.5 text-xs font-semibold text-[#103354] bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg inline-flex items-center gap-1.5 min-h-[40px] whitespace-nowrap shrink-0"
            >
              <Globe className="w-3.5 h-3.5 text-[#008C87]" />
              <span>{lang === 'ar' ? 'English' : 'العربية'}</span>
            </button>
          </div>
        </header>

        {/* Mobile Mode Notice Strip (compact, non-sticky) */}
        <div className="md:hidden px-4 py-1.5 bg-slate-100 border-b border-slate-200 text-[11px] text-slate-600 flex items-center justify-between">
          <span>
            {isConnectedMode
              ? isAr
                ? 'بيئة تطوير متصلة · Supabase'
                : 'Connected Dev · Supabase'
              : t.prototypeBadge}
          </span>
          <span>{isAr ? state.pharmacy.nameAr : state.pharmacy.nameEn}</span>
        </div>

        {/* Viewport Content */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1400px] w-full mx-auto">
          {asyncError && (
            <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-900 flex items-center justify-between gap-3">
              <span>{asyncError}</span>
              <button
                type="button"
                onClick={clearAsyncError}
                className="text-red-700 hover:text-red-900 p-1 shrink-0"
                aria-label={t.common.close}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
          {children}
        </main>
      </div>

      {/* Mobile Slide-Over Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/50"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-72 max-w-[85vw] bg-white h-full flex flex-col border-e border-slate-200 z-10">
            <div className="px-4 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#103354] text-white flex items-center justify-center">
                  <Activity className="w-4 h-4 text-[#00D1C7]" />
                </div>
                <span className="font-bold text-[#103354]">{t.brandName}</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 min-h-[44px] min-w-[44px] flex items-center justify-center"
                aria-label={t.common.close}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeNav === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavClick(item.id)}
                    className={`w-full flex items-center justify-between px-3 py-3 rounded-lg text-sm font-medium min-h-[44px] ${
                      isActive ? 'bg-[#103354] text-white' : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <Icon className="w-4 h-4" />
                      <span>{item.label}</span>
                    </span>
                    {item.badgeCount !== undefined && item.badgeCount > 0 && (
                      <span className="text-xs font-mono tabular-nums">{item.badgeCount}</span>
                    )}
                  </button>
                );
              })}
            </nav>
            {/* PRODUCTION BOUNDARY (Stage 2B): Mirror removal of demo staff switcher and Reset Demo Data in mobile drawer before live CRM/Auth. */}
            <div className="p-4 border-t border-slate-200 space-y-2">
              {isConnectedMode ? (
                <>
                  <div className="text-xs">
                    <div className="font-bold text-[#103354]">
                      {authenticatedPharmacist?.staff.fullName ?? state.staff[0]?.fullName ?? '—'}
                    </div>
                    {authenticatedPharmacist && (
                      <div className="text-[11px] text-[#008C87]">
                        {t.roles[authenticatedPharmacist.role]}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      void signOut();
                    }}
                    className="w-full py-2 text-xs font-semibold text-red-700 border border-red-200 bg-red-50 rounded-lg flex items-center justify-center gap-1.5"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>{isAr ? 'تسجيل الخروج' : 'Sign Out'}</span>
                  </button>
                </>
              ) : (
                <>
                  <select
                    value={state.activeStaffId}
                    onChange={(e) => setActiveStaffId(e.target.value)}
                    className="w-full px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                  >
                    {state.staff.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.fullName}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => {
                      resetDemoData();
                      setMobileMenuOpen(false);
                    }}
                    className="w-full py-2 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg flex items-center justify-center gap-1.5"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{t.common.resetDemo}</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Toast Stack */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 end-4 z-50 space-y-2 max-w-sm w-full px-4 sm:px-0 pointer-events-none">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`pointer-events-auto flex items-center justify-between gap-3 px-4 py-3 rounded-xl border bg-white text-sm shadow-sm ${
                toast.tone === 'error'
                  ? 'border-red-300 text-red-900'
                  : toast.tone === 'warning'
                    ? 'border-amber-300 text-amber-900'
                    : 'border-teal-300 text-[#103354]'
              }`}
            >
              <div className="flex items-center gap-2">
                <CheckCircle2
                  className={`w-4 h-4 shrink-0 ${
                    toast.tone === 'error'
                      ? 'text-red-600'
                      : toast.tone === 'warning'
                        ? 'text-amber-600'
                        : 'text-[#008C87]'
                  }`}
                />
                <span>{toast.text}</span>
              </div>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                className="text-slate-400 hover:text-slate-600 p-1"
                aria-label={t.common.close}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
