import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { Language, Pharmacy, PharmacyStaff } from '../types/domain';

export type AuthoritativePharmacistRole = 'pharmacy_owner' | 'authorized_pharmacist';

export interface AuthenticatedPharmacistContext {
  userId: string;
  email: string | null;
  pharmacyId: string;
  role: AuthoritativePharmacistRole;
  staff: PharmacyStaff;
  pharmacy: Pharmacy;
}

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHORIZED_STAFF_NOT_FOUND'
  | 'STAFF_INACTIVE'
  | 'ROLE_NOT_AUTHORIZED'
  | 'PHARMACY_INACTIVE'
  | 'DB_ERROR'
  | 'UNAUTHENTICATED';

export type AuthResolutionResult =
  | {
      ok: true;
      context: AuthenticatedPharmacistContext;
    }
  | {
      ok: false;
      errorCode: AuthErrorCode;
      message: string;
      hasAuthSession: boolean;
    };

interface StaffRow {
  id: string;
  pharmacy_id: string;
  full_name: string;
  role: string;
  syndicate_license: string | null;
  phone: string;
  is_active: boolean;
}

interface PharmacyRow {
  id: string;
  name_ar: string;
  name_en: string;
  city: string;
  governorate: string;
  license_number: string;
  phone: string;
  timezone: 'Asia/Baghdad';
  is_active: boolean;
}

export interface SupabaseAuthLike {
  auth: {
    getSession(): Promise<{ data: { session: Session | null }; error: { message: string } | null }>;
    signInWithPassword(credentials: {
      email: string;
      password: string;
    }): Promise<{
      data: { user: User | null; session: Session | null };
      error: { message: string; status?: number } | null;
    }>;
    signOut(): Promise<{ error: { message: string } | null }>;
    onAuthStateChange?(
      callback: (event: string, session: Session | null) => void
    ): { data: { subscription: { unsubscribe(): void } } };
  };
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
}

export function getBilingualAuthErrorMessage(code: AuthErrorCode, lang: Language): string {
  const isAr = lang === 'ar';
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return isAr
        ? 'البريد الإلكتروني أو كلمة المرور غير صحيحة.'
        : 'Invalid email or password.';
    case 'UNAUTHORIZED_STAFF_NOT_FOUND':
      return isAr
        ? 'هذا الحساب غير مسجل ضمن كادر الصيدلية المخول في النظام. يُرفض دخول حسابات المراجعين أو الحسابات غير المرتبطة.'
        : 'This account is not linked to an authorized pharmacy_staff record. Patient or unlinked accounts cannot access the CRM.';
    case 'STAFF_INACTIVE':
      return isAr
        ? 'تم تعطيل صلاحية حساب الصيدلي هذا (is_active = false). تواصل مع مالك الصيدلية.'
        : 'This pharmacist staff account has been deactivated (is_active = false). Contact your pharmacy owner.';
    case 'ROLE_NOT_AUTHORIZED':
      return isAr
        ? 'الدور الوظيفي لهذا الحساب غير مخول للوصول إلى لوحة الصيدلي.'
        : 'Account role is not authorized for pharmacist CRM access.';
    case 'PHARMACY_INACTIVE':
      return isAr
        ? 'الصيدلية المرتبطة بهذا الحساب غير مفعّلة حالياً.'
        : 'The pharmacy assigned to this account is currently inactive.';
    case 'DB_ERROR':
      return isAr
        ? 'تعذر التحقق من صلاحية الحساب مع قاعدة البيانات. يرجى المحاولة لاحقاً.'
        : 'Could not verify staff authorization against database. Please retry.';
    case 'UNAUTHENTICATED':
    default:
      return isAr ? 'يرجى تسجيل الدخول للمتابعة.' : 'Please sign in to continue.';
  }
}

/**
 * Authoritatively resolves an authenticated Supabase `User` against
 * `public.pharmacy_staff` (strictly by `id === user.id`, `is_active === true`,
 * `role IN ('pharmacy_owner', 'authorized_pharmacist')`) and its active
 * `public.pharmacies` record.
 *
 * SECURITY: Never trusts `user.user_metadata` or `user.app_metadata` for
 * `pharmacy_id` or `role`.
 */
export async function resolveAuthoritativePharmacistSession(
  client: SupabaseAuthLike | SupabaseClient,
  user: Pick<User, 'id' | 'email'> | null
): Promise<AuthResolutionResult> {
  if (!user || !user.id) {
    return {
      ok: false,
      errorCode: 'UNAUTHENTICATED',
      message: 'No authenticated user session.',
      hasAuthSession: false,
    };
  }

  const db = client as SupabaseAuthLike;

  const staffRes = await db
    .from('pharmacy_staff')
    .select('id, pharmacy_id, full_name, role, syndicate_license, phone, is_active')
    .eq('id', user.id)
    .maybeSingle();

  if (staffRes.error) {
    return {
      ok: false,
      errorCode: 'DB_ERROR',
      message: `Failed to verify pharmacy_staff membership: ${staffRes.error.message}`,
      hasAuthSession: true,
    };
  }

  const staffRow = staffRes.data as StaffRow | null;
  if (!staffRow || staffRow.id !== user.id) {
    return {
      ok: false,
      errorCode: 'UNAUTHORIZED_STAFF_NOT_FOUND',
      message: 'Authenticated account is not registered in public.pharmacy_staff.',
      hasAuthSession: true,
    };
  }

  if (!staffRow.is_active) {
    return {
      ok: false,
      errorCode: 'STAFF_INACTIVE',
      message: 'Pharmacist staff record is inactive.',
      hasAuthSession: true,
    };
  }

  if (staffRow.role !== 'pharmacy_owner' && staffRow.role !== 'authorized_pharmacist') {
    return {
      ok: false,
      errorCode: 'ROLE_NOT_AUTHORIZED',
      message: `Unauthorized staff role: ${staffRow.role}`,
      hasAuthSession: true,
    };
  }

  if (typeof staffRow.pharmacy_id !== 'string' || !staffRow.pharmacy_id.trim()) {
    return {
      ok: false,
      errorCode: 'PHARMACY_INACTIVE',
      message: 'Staff record has no assigned pharmacy.',
      hasAuthSession: true,
    };
  }

  const pharmacyRes = await db
    .from('pharmacies')
    .select('id, name_ar, name_en, city, governorate, license_number, phone, timezone, is_active')
    .eq('id', staffRow.pharmacy_id)
    .maybeSingle();

  if (pharmacyRes.error) {
    return {
      ok: false,
      errorCode: 'DB_ERROR',
      message: `Failed to load pharmacy record: ${pharmacyRes.error.message}`,
      hasAuthSession: true,
    };
  }

  const pharmacyRow = pharmacyRes.data as PharmacyRow | null;
  if (!pharmacyRow || pharmacyRow.id !== staffRow.pharmacy_id || pharmacyRow.is_active !== true) {
    return {
      ok: false,
      errorCode: 'PHARMACY_INACTIVE',
      message: 'Pharmacy record is missing, mismatched, or inactive.',
      hasAuthSession: true,
    };
  }

  return {
    ok: true,
    context: {
      userId: user.id,
      email: user.email ?? null,
      pharmacyId: staffRow.pharmacy_id,
      role: staffRow.role,
      staff: {
        id: staffRow.id,
        pharmacyId: staffRow.pharmacy_id,
        fullName: staffRow.full_name,
        role: staffRow.role,
        syndicateLicense: staffRow.syndicate_license ?? undefined,
        phone: staffRow.phone,
        isActive: staffRow.is_active,
      },
      pharmacy: {
        id: pharmacyRow.id,
        nameAr: pharmacyRow.name_ar,
        nameEn: pharmacyRow.name_en,
        city: pharmacyRow.city,
        governorate: pharmacyRow.governorate,
        licenseNumber: pharmacyRow.license_number,
        phone: pharmacyRow.phone,
        timezone: 'Asia/Baghdad',
      },
    },
  };
}

export async function enforceUnauthorizedSessionSignOut(
  client: SupabaseAuthLike | SupabaseClient,
  resolved: AuthResolutionResult
): Promise<AuthResolutionResult> {
  if (!resolved.ok && resolved.hasAuthSession && resolved.errorCode !== 'DB_ERROR') {
    const authClient = client as SupabaseAuthLike;
    await authClient.auth.signOut().catch(() => undefined);
    return { ...resolved, hasAuthSession: false };
  }
  return resolved;
}

export async function resolveAndEnforceAuthoritativePharmacistSession(
  client: SupabaseAuthLike | SupabaseClient,
  user: Pick<User, 'id' | 'email'> | null
): Promise<AuthResolutionResult> {
  const resolved = await resolveAuthoritativePharmacistSession(client, user);
  return enforceUnauthorizedSessionSignOut(client, resolved);
}

export type ActiveSessionVerificationResult =
  | { status: 'verified'; userId: string }
  | { status: 'missing' }
  | { status: 'mismatched'; actualUserId: string }
  | { status: 'error'; message: string };

export async function verifyActiveSessionMatchesUser(
  client: SupabaseAuthLike | SupabaseClient,
  expectedUserId: string
): Promise<ActiveSessionVerificationResult> {
  try {
    const authClient = client as SupabaseAuthLike;
    const { data, error } = await authClient.auth.getSession();
    if (error) {
      return {
        status: 'error',
        message: error.message || 'Temporary session verification failure.',
      };
    }
    const sessionUserId = data.session?.user?.id;
    if (!sessionUserId) {
      return { status: 'missing' };
    }
    if (sessionUserId !== expectedUserId) {
      return { status: 'mismatched', actualUserId: sessionUserId };
    }
    return { status: 'verified', userId: sessionUserId };
  } catch (err) {
    return {
      status: 'error',
      message:
        err instanceof Error ? err.message : 'Temporary session verification failure.',
    };
  }
}

export async function signInPharmacistWithPassword(
  client: SupabaseAuthLike | SupabaseClient,
  email: string,
  password: string,
  options?: { autoSignOut?: boolean }
): Promise<AuthResolutionResult> {
  const cleanEmail = email.trim();
  if (!cleanEmail || !password) {
    return {
      ok: false,
      errorCode: 'INVALID_CREDENTIALS',
      message: 'Email and password are required.',
      hasAuthSession: false,
    };
  }

  const authClient = client as SupabaseAuthLike;
  const { data, error } = await authClient.auth.signInWithPassword({
    email: cleanEmail,
    password,
  });

  if (error || !data.user) {
    return {
      ok: false,
      errorCode: 'INVALID_CREDENTIALS',
      message: error?.message ?? 'Invalid login credentials.',
      hasAuthSession: false,
    };
  }

  const autoSignOut = options?.autoSignOut ?? true;
  return autoSignOut
    ? resolveAndEnforceAuthoritativePharmacistSession(authClient, data.user)
    : resolveAuthoritativePharmacistSession(authClient, data.user);
}

export async function restorePharmacistSession(
  client: SupabaseAuthLike | SupabaseClient,
  options?: { autoSignOut?: boolean }
): Promise<AuthResolutionResult> {
  const authClient = client as SupabaseAuthLike;
  let session: Session | null = null;
  try {
    const { data, error } = await authClient.auth.getSession();
    if (error) {
      return {
        ok: false,
        errorCode: 'DB_ERROR',
        message: error.message,
        hasAuthSession: false,
      };
    }
    session = data.session;
  } catch (err) {
    return {
      ok: false,
      errorCode: 'DB_ERROR',
      message: err instanceof Error ? err.message : 'Failed to inspect Supabase session.',
      hasAuthSession: false,
    };
  }

  if (!session?.user) {
    return {
      ok: false,
      errorCode: 'UNAUTHENTICATED',
      message: 'No active Supabase session.',
      hasAuthSession: false,
    };
  }
  const autoSignOut = options?.autoSignOut ?? true;
  return autoSignOut
    ? resolveAndEnforceAuthoritativePharmacistSession(authClient, session.user)
    : resolveAuthoritativePharmacistSession(authClient, session.user);
}

export async function signOutPharmacist(
  client: SupabaseAuthLike | SupabaseClient
): Promise<void> {
  const authClient = client as SupabaseAuthLike;
  const { error } = await authClient.auth.signOut();
  if (error) {
    throw new Error(`Sign out failed: ${error.message}`);
  }
}

export function subscribePharmacistAuthState(
  client: SupabaseClient,
  onChange: (event: string, session: Session | null) => void
): () => void {
  const { data } = client.auth.onAuthStateChange((event, session) => {
    onChange(event, session);
  });
  return () => data.subscription.unsubscribe();
}
