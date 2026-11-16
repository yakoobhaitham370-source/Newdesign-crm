import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AllergyOverrideAuthorization,
  BackendSafetyCapabilities,
  ConsultationStatus,
  DashboardKpis,
  DispensingEvent,
  DoseConfirmationStatus,
  FollowUpContactLog,
  FollowUpStatus,
  FollowUpTask,
  LabResult,
  Language,
  MedicationPlanStatus,
  Patient,
  PatientApkInvitation,
  PatientMedicationPlan,
  RefillProjection,
} from '../types/domain';
import {
  AsyncInMemoryCrmRepository,
  computeAllRefillProjections,
  computeDashboardKpis,
  CrmState,
  DEFAULT_DEMO_SAFETY_CAPABILITIES,
  IAsyncCrmRepository,
  InMemoryCrmAdapter,
  NewMedicationPlanInput,
  NewPatientInput,
  RecordDispensingInput,
} from '../services/crmRepository';
import {
  ClockMode,
  DEMO_FIXTURE_DATE,
  FixedBaghdadClock,
  getActiveClock,
  isDemoClockModeEnabled,
  LiveBaghdadClock,
  msUntilNextBaghdadMidnight,
  resolveRuntimeClockMode,
  setActiveClock,
} from '../services/clockService';
import {
  getSupabaseClient,
  getSupabaseConfigStatus,
  isConnectedModeEnabled,
} from '../services/supabaseClient';
import {
  AuthenticatedPharmacistContext,
  subscribePharmacistAuthState,
} from '../services/authService';
import { ConnectedSessionController } from '../services/connectedSessionController';
import {
  createEmptyConnectedCrmState,
  isConnectedAuthorizationError,
  isSupabaseRlsPermissionError,
  LEGACY_0004_SAFETY_CAPABILITIES,
  SupabaseCrmRepository,
} from '../services/supabaseCrmRepository';
import { isAllergyPersistenceVerificationError } from '../services/patientAllergyHelpers';

export type NavSection =
  | 'dashboard'
  | 'patients'
  | 'patient-detail'
  | 'dispensing'
  | 'refills'
  | 'invitations'
  | 'followups'
  | 'consultations'
  | 'analytics'
  | 'governance';

export type AuthStatus =
  | 'demo'
  | 'checking'
  | 'unauthenticated'
  | 'authenticated'
  | 'unauthorized'
  | 'connection_error'
  | 'config_error';

interface ToastMessage {
  id: string;
  text: string;
  tone: 'success' | 'warning' | 'error';
}

interface CrmContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  toggleLang: () => void;
  use12Hour: boolean;
  setUse12Hour: (v: boolean) => void;
  activeNav: NavSection;
  selectedPatientId: string | null;
  navigateTo: (nav: NavSection, patientId?: string | null) => void;
  state: CrmState;
  kpis: DashboardKpis;
  refillProjections: RefillProjection[];
  // Mode & Auth Boundary (Stage 2B.1)
  isConnectedMode: boolean;
  authStatus: AuthStatus;
  authError: string | null;
  hasUnauthorizedSession: boolean;
  authenticatedPharmacist: AuthenticatedPharmacistContext | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  retrySession: () => Promise<void>;
  refreshState: () => Promise<void>;
  // Demo-only controls (disabled in Connected Mode)
  setActiveStaffId: (staffId: string) => void;
  resetDemoData: () => void;
  // Clock & Async Repository Readiness
  todayStr: string;
  clockMode: ClockMode;
  demoClockAllowed: boolean;
  setClockMode: (mode: ClockMode) => void;
  isLoading: boolean;
  asyncError: string | null;
  clearAsyncError: () => void;
  backendCapabilities: BackendSafetyCapabilities;
  refreshBackendCapabilities: () => Promise<void>;
  asyncRepository: IAsyncCrmRepository;
  // Patient actions
  addPatient: (data: NewPatientInput) => Promise<Patient>;
  updatePatient: (patientId: string, updates: Partial<Patient>) => Promise<void>;
  archivePatient: (patientId: string, reason: string) => Promise<void>;
  restorePatient: (patientId: string) => Promise<void>;
  // Medication actions
  addMedicationPlan: (
    data: NewMedicationPlanInput,
    allergyOverride?: AllergyOverrideAuthorization
  ) => Promise<PatientMedicationPlan>;
  updateMedicationPlan: (
    planId: string,
    updates: NewMedicationPlanInput,
    changeReason: string,
    expectedVersionNumber?: number,
    allergyOverride?: AllergyOverrideAuthorization
  ) => Promise<void>;
  changeMedicationStatus: (
    planId: string,
    status: MedicationPlanStatus,
    reason: string
  ) => Promise<void>;
  // Dispensing
  recordDispensing: (params: RecordDispensingInput) => Promise<DispensingEvent | null>;
  // Dose confirmation status update
  updateDoseEventStatus: (
    doseId: string,
    status: DoseConfirmationStatus,
    note?: string
  ) => Promise<void>;
  // Lab results
  addLabResult: (data: Omit<LabResult, 'id' | 'pharmacyId' | 'recordedByStaffName'>) => Promise<void>;
  // Follow-ups
  addFollowUp: (
    data: Omit<FollowUpTask, 'id' | 'pharmacyId' | 'createdAt' | 'contactHistory'>
  ) => Promise<void>;
  updateFollowUpStatus: (followUpId: string, status: FollowUpStatus) => Promise<void>;
  addFollowUpContactLog: (
    followUpId: string,
    log: Omit<FollowUpContactLog, 'id' | 'contactedAt' | 'staffName'>
  ) => Promise<void>;
  // Consultations
  sendConsultationReply: (
    threadId: string,
    body: string,
    newStatus?: ConsultationStatus
  ) => Promise<void>;
  updateConsultationStatus: (threadId: string, status: ConsultationStatus) => Promise<void>;
  // Invitations
  issueInvitation: (
    patientId: string,
    method: 'national_id_last4' | 'dob_and_phone_otp'
  ) => Promise<PatientApkInvitation | null>;
  revokeInvitation: (patientId: string, reason?: string) => Promise<void>;
  simulateInvitationActivation: (patientId: string) => Promise<void>;
  simulateInvitationExpiry: (patientId: string) => Promise<void>;
  // Toasts
  toasts: ToastMessage[];
  pushToast: (text: string, tone?: ToastMessage['tone']) => void;
  dismissToast: (id: string) => void;
}

const CrmContext = createContext<CrmContextValue | null>(null);

export const CrmProvider: React.FC<{
  children: React.ReactNode;
  initialClockMode?: ClockMode;
}> = ({ children, initialClockMode = 'live_baghdad' }) => {
  const isConnectedMode = isConnectedModeEnabled();
  const demoClockAllowed = !isConnectedMode && isDemoClockModeEnabled();

  const [lang, setLang] = useState<Language>('ar');
  const [use12Hour, setUse12Hour] = useState<boolean>(true);
  const [activeNav, setActiveNav] = useState<NavSection>('dashboard');
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);

  const [clockMode, setClockModeState] = useState<ClockMode>(() => {
    const safeMode = resolveRuntimeClockMode(initialClockMode, demoClockAllowed);
    const initial =
      safeMode === 'live_baghdad'
        ? new LiveBaghdadClock()
        : new FixedBaghdadClock(DEMO_FIXTURE_DATE);
    setActiveClock(initial);
    return initial.mode;
  });

  const [todayStr, setTodayStr] = useState<string>(() => getActiveClock().todayDateStr());

  const setClockMode = (mode: ClockMode) => {
    if (isConnectedMode) return;
    const safeMode = resolveRuntimeClockMode(mode, demoClockAllowed);
    const nextClock =
      safeMode === 'live_baghdad' ? new LiveBaghdadClock() : new FixedBaghdadClock(DEMO_FIXTURE_DATE);
    setActiveClock(nextClock);
    setClockModeState(safeMode);
    setTodayStr(nextClock.todayDateStr());
  };

  useEffect(() => {
    const syncToday = () => {
      const latest = getActiveClock().todayDateStr();
      setTodayStr((prev) => (prev === latest ? prev : latest));
    };

    syncToday();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncToday();
      }
    };

    window.addEventListener('focus', syncToday);
    document.addEventListener('visibilitychange', onVisibilityChange);

    let midnightTimer: ReturnType<typeof setTimeout> | undefined;
    let pollInterval: ReturnType<typeof setInterval> | undefined;

    const scheduleMidnightTick = () => {
      if (clockMode !== 'live_baghdad') return;
      midnightTimer = setTimeout(() => {
        syncToday();
        scheduleMidnightTick();
      }, msUntilNextBaghdadMidnight());
    };

    if (clockMode === 'live_baghdad') {
      scheduleMidnightTick();
      pollInterval = setInterval(syncToday, 60_000);
    }

    return () => {
      window.removeEventListener('focus', syncToday);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (midnightTimer !== undefined) clearTimeout(midnightTimer);
      if (pollInterval !== undefined) clearInterval(pollInterval);
    };
  }, [clockMode]);

  // Demo-mode in-memory adapter is created ONLY when Connected Mode is OFF.
  const demoAdapterRef = useRef<InMemoryCrmAdapter | null>(null);
  const demoAsyncRepoRef = useRef<AsyncInMemoryCrmRepository | null>(null);
  if (!isConnectedMode) {
    if (!demoAdapterRef.current) {
      demoAdapterRef.current = new InMemoryCrmAdapter();
    }
    if (!demoAsyncRepoRef.current) {
      demoAsyncRepoRef.current = new AsyncInMemoryCrmRepository(demoAdapterRef.current);
    }
  }

  // Disconnected placeholder repository returned only before Connected login completes
  const unauthenticatedStubRepoRef = useRef<IAsyncCrmRepository | null>(null);
  if (isConnectedMode && !unauthenticatedStubRepoRef.current) {
    const rejectUnauth = async () => {
      throw new Error('Authenticated pharmacist session is required before accessing Connected CRM.');
    };
    unauthenticatedStubRepoRef.current = {
      mode: 'supabase_stage2',
      getStateAsync: rejectUnauth,
      resetAsync: rejectUnauth,
      setActiveStaffAsync: rejectUnauth,
      addPatientAsync: rejectUnauth,
      updatePatientAsync: rejectUnauth,
      archivePatientAsync: rejectUnauth,
      restorePatientAsync: rejectUnauth,
      addMedicationPlanAsync: rejectUnauth,
      updateMedicationPlanAsync: rejectUnauth,
      changeMedicationStatusAsync: rejectUnauth,
      recordDispensingAsync: rejectUnauth,
      updateDoseEventStatusAsync: rejectUnauth,
      addLabResultAsync: rejectUnauth,
      addFollowUpAsync: rejectUnauth,
      updateFollowUpStatusAsync: rejectUnauth,
      addFollowUpContactLogAsync: rejectUnauth,
      sendConsultationReplyAsync: rejectUnauth,
      updateConsultationStatusAsync: rejectUnauth,
      issueInvitationAsync: rejectUnauth,
      revokeInvitationAsync: rejectUnauth,
      getBackendCapabilitiesAsync: rejectUnauth,
      refreshBackendCapabilitiesAsync: rejectUnauth,
    };
  }

  const connectedRepoRef = useRef<IAsyncCrmRepository | null>(null);
  const sessionControllerRef = useRef<ConnectedSessionController | null>(null);

  const [state, setState] = useState<CrmState>(() =>
    isConnectedMode ? createEmptyConnectedCrmState() : demoAdapterRef.current!.getState()
  );
  const [authStatus, setAuthStatus] = useState<AuthStatus>(() =>
    isConnectedMode ? 'checking' : 'demo'
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [hasUnauthorizedSession, setHasUnauthorizedSession] = useState<boolean>(false);
  const [authenticatedPharmacist, setAuthenticatedPharmacist] =
    useState<AuthenticatedPharmacistContext | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(isConnectedMode);
  const [asyncError, setAsyncError] = useState<string | null>(null);
  const [connectedCapabilities, setConnectedCapabilities] =
    useState<BackendSafetyCapabilities | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);

  const langRef = useRef(lang);
  langRef.current = lang;

  useEffect(() => {
    if (!isConnectedMode) return;

    const cfg = getSupabaseConfigStatus();
    if (!cfg.isConfigured) {
      setAuthStatus('config_error');
      setAuthError(cfg.errorMessage);
      setIsLoading(false);
      return;
    }

    const client = getSupabaseClient();
    const controller = new ConnectedSessionController({
      client,
      createRepository: (supabaseClient, context) =>
        new SupabaseCrmRepository(supabaseClient as ReturnType<typeof getSupabaseClient>, context),
      callbacks: {
        getLang: () => langRef.current,
        setRepo: (repo) => {
          connectedRepoRef.current = repo;
        },
        getRepo: () => connectedRepoRef.current,
        setState,
        setAuthStatus,
        setAuthError,
        setHasUnauthorizedSession,
        setAuthenticatedPharmacist,
        setIsLoading,
        setAsyncError,
        setBackendCapabilities: setConnectedCapabilities,
        resetNavigation: () => {
          setActiveNav('dashboard');
          setSelectedPatientId(null);
        },
      },
    });
    sessionControllerRef.current = controller;

    void controller.restoreInitialSession();

    const unsubscribe = subscribePharmacistAuthState(client, (event, session) => {
      void controller.handleAuthStateChange(event, session);
    });

    let lastBackgroundRevalidationAt = 0;
    const revalidateIfNeeded = () => {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      if (!controller.getCoordinator().getActiveUserId()) return;
      const now = Date.now();
      if (now - lastBackgroundRevalidationAt < 15_000) return;
      lastBackgroundRevalidationAt = now;
      void controller.revalidateActiveSession();
    };

    window.addEventListener('focus', revalidateIfNeeded);
    document.addEventListener('visibilitychange', revalidateIfNeeded);

    return () => {
      window.removeEventListener('focus', revalidateIfNeeded);
      document.removeEventListener('visibilitychange', revalidateIfNeeded);
      unsubscribe();
      controller.dispose();
      if (sessionControllerRef.current === controller) {
        sessionControllerRef.current = null;
      }
    };
  }, [isConnectedMode]);

  const activeRepository: IAsyncCrmRepository = isConnectedMode
    ? connectedRepoRef.current ?? unauthenticatedStubRepoRef.current!
    : demoAsyncRepoRef.current!;

  const backendCapabilities: BackendSafetyCapabilities = !isConnectedMode
    ? DEFAULT_DEMO_SAFETY_CAPABILITIES
    : connectedCapabilities ?? LEGACY_0004_SAFETY_CAPABILITIES;

  const pushToast = (text: string, tone: ToastMessage['tone'] = 'success') => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    setToasts((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const clearAsyncError = () => setAsyncError(null);

  const toggleLang = () => setLang((prev) => (prev === 'ar' ? 'en' : 'ar'));

  const navigateTo = (nav: NavSection, patientId: string | null = null) => {
    setActiveNav(nav);
    if (patientId !== undefined) {
      setSelectedPatientId(patientId);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const signIn = async (email: string, password: string) => {
    if (!isConnectedMode) return;
    const cfg = getSupabaseConfigStatus();
    if (!cfg.isConfigured) {
      setAuthStatus('config_error');
      const msg = cfg.errorMessage ?? 'Invalid Supabase configuration.';
      setAuthError(msg);
      throw new Error(msg);
    }
    const controller = sessionControllerRef.current;
    if (!controller) {
      throw new Error('Connected session controller is not initialized.');
    }
    await controller.signIn(email, password);
  };

  const signOut = async () => {
    if (!isConnectedMode) return;
    const controller = sessionControllerRef.current;
    if (controller) {
      await controller.signOut();
      return;
    }
    connectedRepoRef.current = null;
    setAuthenticatedPharmacist(null);
    setConnectedCapabilities(null);
    setState(createEmptyConnectedCrmState());
    setHasUnauthorizedSession(false);
    setAuthError(null);
    setAsyncError(null);
    setActiveNav('dashboard');
    setSelectedPatientId(null);
    setAuthStatus('unauthenticated');
  };

  const retrySession = async () => {
    if (!isConnectedMode) return;
    const cfg = getSupabaseConfigStatus();
    if (!cfg.isConfigured) {
      setAuthStatus('config_error');
      setAuthError(cfg.errorMessage);
      return;
    }
    await sessionControllerRef.current?.retrySessionCheck();
  };

  const refreshState = async () => {
    if (isConnectedMode) {
      await sessionControllerRef.current?.refreshState();
    } else {
      const nextState = await activeRepository.getStateAsync();
      setState(nextState);
    }
  };

  const refreshBackendCapabilities = async () => {
    if (isConnectedMode) {
      await sessionControllerRef.current?.refreshCapabilities();
    } else if (activeRepository.refreshBackendCapabilitiesAsync) {
      await activeRepository.refreshBackendCapabilitiesAsync();
    }
  };

  const setActiveStaffId = (staffId: string) => {
    if (isConnectedMode) {
      pushToast(
        lang === 'ar'
          ? 'تغيير الصيدلي يدوياً معطّل في الوضع المتصل؛ الهوية مرتبطة بالجلسة الموثقة.'
          : 'Manual staff switching is disabled in Connected Mode.',
        'warning'
      );
      return;
    }
    setState(demoAdapterRef.current!.setActiveStaff(staffId));
  };

  const resetDemoData = () => {
    if (isConnectedMode) {
      pushToast(
        lang === 'ar'
          ? 'إعادة ضبط البيانات التجريبية معطّلة في الوضع المتصل.'
          : 'Demo reset is disabled in Connected Mode.',
        'warning'
      );
      return;
    }
    setState(demoAdapterRef.current!.reset());
    setActiveNav('dashboard');
    setSelectedPatientId(null);
    pushToast(
      lang === 'ar'
        ? 'تمت إعادة ضبط البيانات التجريبية الافتراضية.'
        : 'Demonstration dataset has been reset.',
      'success'
    );
  };

  const kpis = useMemo(
    () => computeDashboardKpis(state, lang, todayStr),
    [state, lang, todayStr]
  );

  const refillProjections = useMemo(
    () => computeAllRefillProjections(state, lang, todayStr),
    [state, lang, todayStr]
  );

  const applyStateIfSessionCurrent = (
    nextState: CrmState,
    capturedGen: number | null,
    capturedUserId: string | null
  ) => {
    if (!isConnectedMode) {
      setState(nextState);
      return;
    }
    const controller = sessionControllerRef.current;
    if (
      controller &&
      capturedGen !== null &&
      capturedUserId !== null &&
      controller.isActiveUserOperation(capturedGen, capturedUserId)
    ) {
      setState(nextState);
    }
  };

  const runMutation = async <T,>(
    fn: (commitState: (nextState: CrmState) => void) => Promise<T>
  ): Promise<T> => {
    const controller = sessionControllerRef.current;
    const capturedGen = isConnectedMode
      ? controller?.getCoordinator().getCurrentGeneration() ?? null
      : null;
    const capturedUserId = isConnectedMode
      ? controller?.getCoordinator().getActiveUserId() ?? null
      : null;
    setIsLoading(true);
    setAsyncError(null);
    try {
      return await fn((nextState) =>
        applyStateIfSessionCurrent(nextState, capturedGen, capturedUserId)
      );
    } catch (err) {
      if (
        isConnectedMode &&
        controller &&
        capturedGen !== null &&
        capturedUserId !== null &&
        controller.isActiveUserOperation(capturedGen, capturedUserId) &&
        (isConnectedAuthorizationError(err) || isSupabaseRlsPermissionError(err))
      ) {
        const lockedOut = await controller.handleRuntimeError(err, {
          expectedGeneration: capturedGen,
          expectedUserId: capturedUserId,
        });
        if (lockedOut) {
          throw err;
        }
      }
      if (isAllergyPersistenceVerificationError(err) && err.reloadedState) {
        applyStateIfSessionCurrent(err.reloadedState, capturedGen, capturedUserId);
      }
      if (
        !isConnectedMode ||
        (controller &&
          capturedGen !== null &&
          capturedUserId !== null &&
          controller.isActiveUserOperation(capturedGen, capturedUserId))
      ) {
        const msg = err instanceof Error ? err.message : 'CRM operation failed.';
        setAsyncError(msg);
      }
      throw err;
    } finally {
      if (
        !isConnectedMode ||
        (controller &&
          capturedGen !== null &&
          capturedUserId !== null &&
          controller.isActiveUserOperation(capturedGen, capturedUserId))
      ) {
        setIsLoading(false);
      }
    }
  };

  const addPatient: CrmContextValue['addPatient'] = (data) =>
    runMutation(async (commitState) => {
      const res = await activeRepository.addPatientAsync(data);
      commitState(res.state);
      return res.patient;
    });

  const updatePatient: CrmContextValue['updatePatient'] = (patientId, updates) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.updatePatientAsync(patientId, updates);
      commitState(nextState);
    });

  const archivePatient: CrmContextValue['archivePatient'] = (patientId, reason) =>
    runMutation(async (commitState) => {
      const nextState = isConnectedMode
        ? await activeRepository.archivePatientAsync(patientId, reason)
        : demoAdapterRef.current!.archivePatient(patientId, reason, todayStr);
      commitState(nextState);
    });

  const restorePatient: CrmContextValue['restorePatient'] = (patientId) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.restorePatientAsync(patientId);
      commitState(nextState);
    });

  const addMedicationPlan: CrmContextValue['addMedicationPlan'] = (data, allergyOverride) =>
    runMutation(async (commitState) => {
      const res = await activeRepository.addMedicationPlanAsync(data, allergyOverride);
      commitState(res.state);
      return res.plan;
    });

  const updateMedicationPlan: CrmContextValue['updateMedicationPlan'] = (
    planId,
    updates,
    changeReason,
    expectedVersionNumber,
    allergyOverride
  ) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.updateMedicationPlanAsync(
        planId,
        updates,
        changeReason,
        todayStr,
        expectedVersionNumber,
        allergyOverride
      );
      commitState(nextState);
    });

  const changeMedicationStatus: CrmContextValue['changeMedicationStatus'] = (
    planId,
    status,
    reason
  ) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.changeMedicationStatusAsync(
        planId,
        status,
        reason,
        todayStr
      );
      commitState(nextState);
    });

  const recordDispensing: CrmContextValue['recordDispensing'] = (params) =>
    runMutation(async (commitState) => {
      const res = await activeRepository.recordDispensingAsync(params, lang);
      commitState(res.state);
      return res.event;
    });

  const updateDoseEventStatus: CrmContextValue['updateDoseEventStatus'] = (
    doseId,
    status,
    note
  ) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.updateDoseEventStatusAsync(doseId, status, note);
      commitState(nextState);
    });

  const addLabResult: CrmContextValue['addLabResult'] = (data) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.addLabResultAsync(data);
      commitState(nextState);
    });

  const addFollowUp: CrmContextValue['addFollowUp'] = (data) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.addFollowUpAsync(data);
      commitState(nextState);
    });

  const updateFollowUpStatus: CrmContextValue['updateFollowUpStatus'] = (followUpId, status) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.updateFollowUpStatusAsync(followUpId, status);
      commitState(nextState);
    });

  const addFollowUpContactLog: CrmContextValue['addFollowUpContactLog'] = (followUpId, log) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.addFollowUpContactLogAsync(followUpId, log);
      commitState(nextState);
    });

  const sendConsultationReply: CrmContextValue['sendConsultationReply'] = (
    threadId,
    body,
    newStatus
  ) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.sendConsultationReplyAsync(
        threadId,
        body,
        newStatus
      );
      commitState(nextState);
    });

  const updateConsultationStatus: CrmContextValue['updateConsultationStatus'] = (
    threadId,
    status
  ) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.updateConsultationStatusAsync(threadId, status);
      commitState(nextState);
    });

  const issueInvitation: CrmContextValue['issueInvitation'] = (patientId, method) =>
    runMutation(async (commitState) => {
      const res = await activeRepository.issueInvitationAsync(patientId, method, todayStr);
      commitState(res.state);
      return res.invitation;
    });

  const revokeInvitation: CrmContextValue['revokeInvitation'] = (patientId, reason) =>
    runMutation(async (commitState) => {
      const nextState = await activeRepository.revokeInvitationAsync(patientId, reason);
      commitState(nextState);
    });

  const simulateInvitationActivation: CrmContextValue['simulateInvitationActivation'] = (
    patientId
  ) =>
    runMutation(async () => {
      if (isConnectedMode || !demoAdapterRef.current) {
        throw new Error(
          'Simulated invitation activation is disabled in Connected Supabase Mode.'
        );
      }
      setState(demoAdapterRef.current.simulateInvitationActivation(patientId));
    });

  const simulateInvitationExpiry: CrmContextValue['simulateInvitationExpiry'] = (patientId) =>
    runMutation(async () => {
      if (isConnectedMode || !demoAdapterRef.current) {
        throw new Error(
          'Simulated invitation expiry is disabled in Connected Supabase Mode.'
        );
      }
      setState(demoAdapterRef.current.simulateInvitationExpiry(patientId));
    });

  return (
    <CrmContext.Provider
      value={{
        lang,
        setLang,
        toggleLang,
        use12Hour,
        setUse12Hour,
        activeNav,
        selectedPatientId,
        navigateTo,
        state,
        kpis,
        refillProjections,
        isConnectedMode,
        authStatus,
        authError,
        hasUnauthorizedSession,
        authenticatedPharmacist,
        signIn,
        signOut,
        retrySession,
        refreshState,
        setActiveStaffId,
        resetDemoData,
        todayStr,
        clockMode,
        demoClockAllowed,
        setClockMode,
        isLoading,
        asyncError,
        clearAsyncError,
        backendCapabilities,
        refreshBackendCapabilities,
        asyncRepository: activeRepository,
        addPatient,
        updatePatient,
        archivePatient,
        restorePatient,
        addMedicationPlan,
        updateMedicationPlan,
        changeMedicationStatus,
        recordDispensing,
        updateDoseEventStatus,
        addLabResult,
        addFollowUp,
        updateFollowUpStatus,
        addFollowUpContactLog,
        sendConsultationReply,
        updateConsultationStatus,
        issueInvitation,
        revokeInvitation,
        simulateInvitationActivation,
        simulateInvitationExpiry,
        toasts,
        pushToast,
        dismissToast,
      }}
    >
      {children}
    </CrmContext.Provider>
  );
};

export function useCrm(): CrmContextValue {
  const ctx = useContext(CrmContext);
  if (!ctx) throw new Error('useCrm must be used within CrmProvider');
  return ctx;
}
