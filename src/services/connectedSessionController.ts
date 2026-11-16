import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import {
  AuthenticatedPharmacistContext,
  AuthResolutionResult,
  getBilingualAuthErrorMessage,
  resolveAuthoritativePharmacistSession,
  restorePharmacistSession,
  signInPharmacistWithPassword,
  signOutPharmacist,
  SupabaseAuthLike,
  verifyActiveSessionMatchesUser,
} from './authService';
import { CrmState, IAsyncCrmRepository } from './crmRepository';
import {
  createEmptyConnectedCrmState,
  isConnectedAuthorizationError,
  isSupabaseRlsPermissionError,
} from './supabaseCrmRepository';
import { BackendSafetyCapabilities, Language } from '../types/domain';

export type ConnectedAuthStatus =
  | 'checking'
  | 'unauthenticated'
  | 'authenticated'
  | 'unauthorized'
  | 'connection_error'
  | 'config_error';

export type InvalidationReason = 'superseded' | 'sign_out' | 'rejected' | 'disposed';

/**
 * Monotonic generation + disposal coordinator protecting Connected Mode against
 * delayed, overlapping, or out-of-order async auth / hydration completions.
 */
export class ConnectedSessionCoordinator {
  private generation = 0;
  private disposed = false;
  private activeUserId: string | null = null;
  private lastInvalidationReason: InvalidationReason | null = null;

  public beginOperation(): number {
    this.generation += 1;
    this.lastInvalidationReason = null;
    return this.generation;
  }

  public getCurrentGeneration(): number {
    return this.generation;
  }

  public getActiveUserId(): string | null {
    return this.activeUserId;
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public getLastInvalidationReason(): InvalidationReason | null {
    return this.lastInvalidationReason;
  }

  public markAuthenticated(opGeneration: number, userId: string): boolean {
    if (!this.isCurrent(opGeneration)) {
      return false;
    }
    this.activeUserId = userId;
    return true;
  }

  public invalidate(reason: InvalidationReason = 'superseded'): number {
    this.generation += 1;
    this.activeUserId = null;
    this.lastInvalidationReason = reason;
    return this.generation;
  }

  public dispose(): void {
    this.disposed = true;
    this.invalidate('disposed');
  }

  public isCurrent(opGeneration: number, expectedUserId?: string): boolean {
    if (this.disposed || opGeneration !== this.generation) {
      return false;
    }
    if (expectedUserId !== undefined && this.activeUserId !== expectedUserId) {
      return false;
    }
    return true;
  }
}

export interface ConnectedSessionCallbacks {
  getLang: () => Language;
  setRepo: (repo: IAsyncCrmRepository | null) => void;
  getRepo: () => IAsyncCrmRepository | null;
  setState: (state: CrmState) => void;
  setAuthStatus: (status: ConnectedAuthStatus) => void;
  setAuthError: (error: string | null) => void;
  setHasUnauthorizedSession: (hasSession: boolean) => void;
  setAuthenticatedPharmacist: (ctx: AuthenticatedPharmacistContext | null) => void;
  setIsLoading: (loading: boolean) => void;
  setAsyncError: (error: string | null) => void;
  setBackendCapabilities?: (capabilities: BackendSafetyCapabilities | null) => void;
  resetNavigation: () => void;
}

export interface ConnectedSessionControllerDeps {
  client: SupabaseAuthLike | SupabaseClient;
  createRepository: (
    client: SupabaseAuthLike | SupabaseClient,
    context: AuthenticatedPharmacistContext
  ) => IAsyncCrmRepository;
  callbacks: ConnectedSessionCallbacks;
}

export class ConnectedSessionController {
  private readonly coordinator = new ConnectedSessionCoordinator();
  private readonly client: SupabaseAuthLike | SupabaseClient;
  private readonly createRepository: ConnectedSessionControllerDeps['createRepository'];
  private readonly callbacks: ConnectedSessionCallbacks;
  private activePharmacyId: string | null = null;
  private manualSignInInFlight = false;
  private revocationSignOutInFlight = false;

  constructor(deps: ConnectedSessionControllerDeps) {
    this.client = deps.client;
    this.createRepository = deps.createRepository;
    this.callbacks = deps.callbacks;
  }

  public getCoordinator(): ConnectedSessionCoordinator {
    return this.coordinator;
  }

  public isActiveUserOperation(opGeneration: number, expectedUserId: string): boolean {
    return this.coordinator.isCurrent(opGeneration, expectedUserId);
  }

  public clearWorkspace(
    nextStatus: 'checking' | 'unauthenticated' | 'unauthorized' | 'connection_error',
    authError: string | null,
    hasUnauthorizedSession: boolean
  ): void {
    this.activePharmacyId = null;
    this.callbacks.setRepo(null);
    this.callbacks.setAuthenticatedPharmacist(null);
    this.callbacks.setBackendCapabilities?.(null);
    this.callbacks.setState(createEmptyConnectedCrmState());
    this.callbacks.setHasUnauthorizedSession(hasUnauthorizedSession);
    this.callbacks.setAuthError(authError);
    this.callbacks.setAsyncError(null);
    this.callbacks.setAuthStatus(nextStatus);
    this.callbacks.setIsLoading(nextStatus === 'checking');
  }

  private async revokeWorkspaceAndSignOut(
    authError: string | null,
    shouldSignOut: boolean
  ): Promise<void> {
    // 1. Invalidate the active generation.
    this.coordinator.invalidate('rejected');
    // 2. Immediately clear active repository, pharmacist context, pharmacy state, and selected patient.
    // 3. Immediately transition the interface to the unauthorized screen.
    this.clearWorkspace('unauthorized', authError, false);
    this.callbacks.resetNavigation();

    // 4. Then attempt Supabase sign-out without leaving sensitive information displayed.
    if (shouldSignOut) {
      this.revocationSignOutInFlight = true;
      try {
        await signOutPharmacist(this.client).catch(() => undefined);
      } finally {
        this.revocationSignOutInFlight = false;
      }
    }
  }

  public async handleRuntimeError(
    err: unknown,
    operationContext?: { expectedGeneration?: number; expectedUserId?: string }
  ): Promise<boolean> {
    if (this.coordinator.isDisposed()) return false;

    if (
      operationContext?.expectedGeneration !== undefined &&
      !this.coordinator.isCurrent(
        operationContext.expectedGeneration,
        operationContext.expectedUserId
      )
    ) {
      return false;
    }

    if (isConnectedAuthorizationError(err)) {
      const lang = this.callbacks.getLang();
      await this.revokeWorkspaceAndSignOut(getBilingualAuthErrorMessage(err.errorCode, lang), true);
      return true;
    }

    if (isSupabaseRlsPermissionError(err)) {
      const valid = await this.revalidateActiveSession();
      return !valid;
    }

    return false;
  }

  private async hydrateRepoState(
    opGen: number,
    expectedUserId: string,
    repo: IAsyncCrmRepository,
    forceCapabilityRefresh = false
  ): Promise<void> {
    this.callbacks.setIsLoading(true);
    this.callbacks.setAsyncError(null);
    try {
      const capabilityPromise = forceCapabilityRefresh && repo.refreshBackendCapabilitiesAsync
        ? repo.refreshBackendCapabilitiesAsync()
        : repo.getBackendCapabilitiesAsync
          ? repo.getBackendCapabilitiesAsync(forceCapabilityRefresh)
          : Promise.resolve(null);
      const [nextState, capabilities] = await Promise.all([
        repo.getStateAsync(),
        capabilityPromise,
      ]);
      if (!this.coordinator.isCurrent(opGen, expectedUserId)) {
        return;
      }

      const sessionCheck = await verifyActiveSessionMatchesUser(this.client, expectedUserId);
      if (!this.coordinator.isCurrent(opGen, expectedUserId)) {
        return;
      }

      if (sessionCheck.status === 'error') {
        const msg = getBilingualAuthErrorMessage('DB_ERROR', this.callbacks.getLang());
        this.coordinator.invalidate('rejected');
        this.clearWorkspace('connection_error', msg, true);
        this.callbacks.resetNavigation();
        return;
      }

      if (sessionCheck.status === 'missing' || sessionCheck.status === 'mismatched') {
        this.coordinator.invalidate('rejected');
        this.clearWorkspace('unauthenticated', null, false);
        this.callbacks.resetNavigation();
        return;
      }

      if (capabilities) {
        this.callbacks.setBackendCapabilities?.(capabilities);
      }
      this.callbacks.setState(nextState);
    } catch (err) {
      if (!this.coordinator.isCurrent(opGen, expectedUserId)) {
        return;
      }

      if (isConnectedAuthorizationError(err)) {
        const lang = this.callbacks.getLang();
        await this.revokeWorkspaceAndSignOut(getBilingualAuthErrorMessage(err.errorCode, lang), true);
        return;
      }

      if (isSupabaseRlsPermissionError(err)) {
        const revalidated = await this.revalidateActiveSession();
        if (!revalidated) {
          return;
        }
        if (
          !this.coordinator.isDisposed() &&
          this.coordinator.getActiveUserId() === expectedUserId
        ) {
          const msg =
            err instanceof Error ? err.message : 'Failed to load pharmacy records from Supabase.';
          this.callbacks.setState(createEmptyConnectedCrmState());
          this.callbacks.setAsyncError(msg);
          this.callbacks.setIsLoading(false);
        }
        return;
      }

      if (!this.coordinator.isCurrent(opGen, expectedUserId)) {
        return;
      }

      const msg =
        err instanceof Error ? err.message : 'Failed to load pharmacy records from Supabase.';
      this.callbacks.setState(createEmptyConnectedCrmState());
      this.callbacks.setAsyncError(msg);
    } finally {
      if (!this.coordinator.isDisposed() && this.coordinator.isCurrent(opGen, expectedUserId)) {
        this.callbacks.setIsLoading(false);
      }
    }
  }

  private async applyAuthResolution(
    opGen: number,
    res: AuthResolutionResult,
    source: 'restore' | 'auth_event' | 'sign_in'
  ): Promise<boolean> {
    if (!this.coordinator.isCurrent(opGen)) {
      if (res.ok && this.coordinator.getLastInvalidationReason() === 'sign_out') {
        await signOutPharmacist(this.client).catch(() => undefined);
      }
      return false;
    }

    if (!res.ok) {
      const lang = this.callbacks.getLang();
      if (res.errorCode === 'DB_ERROR') {
        const msg = getBilingualAuthErrorMessage('DB_ERROR', lang);
        this.coordinator.invalidate('rejected');
        this.clearWorkspace('connection_error', msg, res.hasAuthSession);
        this.callbacks.resetNavigation();
        if (source === 'sign_in') {
          throw new Error(msg);
        }
        return false;
      }

      if (res.errorCode === 'UNAUTHENTICATED') {
        this.coordinator.invalidate('rejected');
        this.clearWorkspace('unauthenticated', null, false);
        if (source !== 'sign_in') {
          this.callbacks.resetNavigation();
        }
        if (source === 'sign_in') {
          throw new Error(getBilingualAuthErrorMessage('UNAUTHENTICATED', lang));
        }
        return false;
      }

      if (res.errorCode === 'INVALID_CREDENTIALS') {
        const invalidMsg = getBilingualAuthErrorMessage('INVALID_CREDENTIALS', lang);
        this.coordinator.invalidate('rejected');
        this.clearWorkspace('unauthenticated', invalidMsg, false);
        this.callbacks.resetNavigation();
        if (source === 'sign_in') {
          throw new Error(invalidMsg);
        }
        return false;
      }

      const msg = getBilingualAuthErrorMessage(res.errorCode, lang);
      await this.revokeWorkspaceAndSignOut(msg, res.hasAuthSession);
      if (source === 'sign_in') {
        throw new Error(msg);
      }
      return false;
    }

    const sessionCheck = await verifyActiveSessionMatchesUser(this.client, res.context.userId);
    if (!this.coordinator.isCurrent(opGen)) {
      if (this.coordinator.getLastInvalidationReason() === 'sign_out') {
        await signOutPharmacist(this.client).catch(() => undefined);
      }
      return false;
    }

    if (sessionCheck.status === 'error') {
      const msg = getBilingualAuthErrorMessage('DB_ERROR', this.callbacks.getLang());
      this.coordinator.invalidate('rejected');
      this.clearWorkspace('connection_error', msg, true);
      this.callbacks.resetNavigation();
      if (source === 'sign_in') {
        throw new Error(msg);
      }
      return false;
    }

    if (sessionCheck.status === 'missing' || sessionCheck.status === 'mismatched') {
      this.coordinator.invalidate('rejected');
      this.clearWorkspace('unauthenticated', null, false);
      this.callbacks.resetNavigation();
      if (source === 'sign_in') {
        throw new Error(
          getBilingualAuthErrorMessage('UNAUTHENTICATED', this.callbacks.getLang())
        );
      }
      return false;
    }

    const prevUserId = this.coordinator.getActiveUserId();
    const prevPharmacyId = this.activePharmacyId;
    const isWorkspaceSwitch =
      prevUserId !== res.context.userId ||
      prevPharmacyId !== res.context.pharmacyId ||
      source === 'sign_in' ||
      source === 'restore';

    if (!this.coordinator.markAuthenticated(opGen, res.context.userId)) {
      return false;
    }
    this.activePharmacyId = res.context.pharmacyId;

    if (isWorkspaceSwitch) {
      this.callbacks.setState(createEmptyConnectedCrmState());
      this.callbacks.resetNavigation();
    }

    const repo = this.createRepository(this.client, res.context);
    this.callbacks.setRepo(repo);
    this.callbacks.setAuthenticatedPharmacist(res.context);
    this.callbacks.setHasUnauthorizedSession(false);
    this.callbacks.setAuthError(null);
    this.callbacks.setAuthStatus('authenticated');

    await this.hydrateRepoState(opGen, res.context.userId, repo);
    return this.coordinator.isCurrent(opGen, res.context.userId);
  }

  public async restoreInitialSession(): Promise<boolean> {
    const opGen = this.coordinator.beginOperation();
    const res = await restorePharmacistSession(this.client, { autoSignOut: false });
    return this.applyAuthResolution(opGen, res, 'restore');
  }

  public async retrySessionCheck(): Promise<boolean> {
    if (this.coordinator.isDisposed()) return false;
    this.clearWorkspace('checking', null, false);
    return this.restoreInitialSession();
  }

  public async revalidateActiveSession(): Promise<boolean> {
    if (this.coordinator.isDisposed()) return false;
    const activeUserId = this.coordinator.getActiveUserId();
    if (!activeUserId) {
      return this.restoreInitialSession();
    }

    const opGen = this.coordinator.beginOperation();
    const res = await restorePharmacistSession(this.client, { autoSignOut: false });
    if (!this.coordinator.isCurrent(opGen)) {
      return false;
    }

    if (
      !res.ok ||
      res.context.userId !== activeUserId ||
      res.context.pharmacyId !== this.activePharmacyId
    ) {
      return this.applyAuthResolution(opGen, res, 'auth_event');
    }

    if (!this.coordinator.markAuthenticated(opGen, res.context.userId)) {
      return false;
    }
    const freshRepo = this.createRepository(this.client, res.context);
    this.callbacks.setRepo(freshRepo);
    this.callbacks.setAuthenticatedPharmacist(res.context);
    if (freshRepo.getBackendCapabilitiesAsync) {
      const caps = await freshRepo.getBackendCapabilitiesAsync(false).catch(() => null);
      if (caps && this.coordinator.isCurrent(opGen, res.context.userId)) {
        this.callbacks.setBackendCapabilities?.(caps);
      }
    }
    return true;
  }

  public async handleAuthStateChange(event: string, session: Session | null): Promise<void> {
    if (this.coordinator.isDisposed()) return;

    if (this.manualSignInInFlight) {
      // signIn() holds the active opGen and authoritatively resolves/applies the session;
      // ignore intermediate auth transitions (e.g. session replacement SIGNED_OUT or
      // prior-user TOKEN_REFRESHED) so they cannot invalidate or sign out the new login.
      return;
    }

    if (!session?.user) {
      if (
        this.revocationSignOutInFlight &&
        this.coordinator.getLastInvalidationReason() === 'rejected'
      ) {
        return;
      }
      this.coordinator.invalidate('sign_out');
      this.clearWorkspace('unauthenticated', null, false);
      this.callbacks.resetNavigation();
      return;
    }

    const user: Pick<User, 'id' | 'email'> = {
      id: session.user.id,
      email: session.user.email,
    };

    const activeUserId = this.coordinator.getActiveUserId();
    if (activeUserId && user.id !== activeUserId) {
      this.clearWorkspace('checking', null, false);
      this.callbacks.resetNavigation();
    }

    const opGen = this.coordinator.beginOperation();
    const res = await resolveAuthoritativePharmacistSession(this.client, user);
    await this.applyAuthResolution(opGen, res, 'auth_event');
  }

  public async signIn(email: string, password: string): Promise<void> {
    if (this.coordinator.getActiveUserId()) {
      this.clearWorkspace('checking', null, false);
      this.callbacks.resetNavigation();
    }
    const opGen = this.coordinator.beginOperation();
    this.manualSignInInFlight = true;
    try {
      const res = await signInPharmacistWithPassword(this.client, email, password, {
        autoSignOut: false,
      });
      await this.applyAuthResolution(opGen, res, 'sign_in');
    } finally {
      this.manualSignInInFlight = false;
    }
  }

  public async signOut(): Promise<void> {
    this.coordinator.invalidate('sign_out');
    this.clearWorkspace('unauthenticated', null, false);
    this.callbacks.resetNavigation();
    await signOutPharmacist(this.client);
  }

  public async refreshState(): Promise<void> {
    if (this.coordinator.isDisposed()) return;
    const repo = this.callbacks.getRepo();
    const userId = this.coordinator.getActiveUserId();
    if (!repo || !userId) {
      await this.restoreInitialSession();
      return;
    }

    const opGen = this.coordinator.beginOperation();
    const res = await restorePharmacistSession(this.client, { autoSignOut: false });
    if (!this.coordinator.isCurrent(opGen)) {
      return;
    }

    if (
      !res.ok ||
      res.context.userId !== userId ||
      res.context.pharmacyId !== this.activePharmacyId
    ) {
      await this.applyAuthResolution(opGen, res, 'auth_event');
      return;
    }

    if (!this.coordinator.markAuthenticated(opGen, res.context.userId)) {
      return;
    }
    const freshRepo = this.createRepository(this.client, res.context);
    this.callbacks.setRepo(freshRepo);
    this.callbacks.setAuthenticatedPharmacist(res.context);
    await this.hydrateRepoState(opGen, res.context.userId, freshRepo, true);
  }

  public async refreshCapabilities(): Promise<BackendSafetyCapabilities | null> {
    if (this.coordinator.isDisposed()) return null;
    const repo = this.callbacks.getRepo();
    const userId = this.coordinator.getActiveUserId();
    const gen = this.coordinator.getCurrentGeneration();
    if (!repo || !userId) return null;

    const caps = repo.refreshBackendCapabilitiesAsync
      ? await repo.refreshBackendCapabilitiesAsync()
      : repo.getBackendCapabilitiesAsync
        ? await repo.getBackendCapabilitiesAsync(true)
        : null;
    if (caps && this.coordinator.isCurrent(gen, userId)) {
      this.callbacks.setBackendCapabilities?.(caps);
    }
    return caps;
  }

  public dispose(): void {
    this.coordinator.dispose();
    this.activePharmacyId = null;
    this.callbacks.setRepo(null);
  }
}
