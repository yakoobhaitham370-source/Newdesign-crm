// ============================================================================
// MASAR Care — Stage 2B.2A.1 Admin Provisioning Edge Function Core Logic
// Pure TypeScript (Deno & Node compatible, zero hardcoded secrets).
// Handles:
//   1) bootstrap-first-owner: one-time initial pharmacy + pharmacy_owner setup
//      with durable bootstrap_state claim/reconciliation + strict
//      MASAR_PLATFORM_ADMIN_TOKEN + MASAR_BOOTSTRAP_TOKEN authentication.
//   2) owner-provision-staff: owner-only authorized_pharmacist creation strictly
//      scoped to caller's pharmacy_id with fail-closed RPC schema checks.
// ============================================================================

export interface AdminSupabaseLike {
  auth: {
    getUser(jwt: string): Promise<{
      data: { user: { id: string; email?: string } | null };
      error: { message: string } | null;
    }>;
    admin: {
      createUser(params: {
        email: string;
        password: string;
        email_confirm: boolean;
      }): Promise<{
        data: { user: { id: string; email?: string } | null };
        error: { message: string; status?: number; code?: string } | null;
      }>;
      deleteUser(userId: string): Promise<{
        data: unknown;
        error: { message: string } | null;
      }>;
    };
  };
  from(table: string): {
    select(columns: string): {
      eq(col: string, val: unknown): {
        eq(col2: string, val2: unknown): {
          maybeSingle(): Promise<{
            data: Record<string, unknown> | null;
            error: { message: string; code?: string } | null;
          }>;
        };
        maybeSingle(): Promise<{
          data: Record<string, unknown> | null;
          error: { message: string; code?: string } | null;
        }>;
      };
    };
  };
  rpc(
    fn: string,
    args?: Record<string, unknown>
  ): Promise<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>;
}

export interface ProvisioningEnv {
  bootstrapToken?: string;
  platformAdminToken?: string;
}

export interface ProvisioningResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const DEFAULT_CORS_ALLOW_HEADERS =
  'authorization, x-client-info, apikey, content-type, idempotency-key';

export function parseAllowedOrigins(allowedOriginsEnv?: string): string[] {
  return (allowedOriginsEnv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '*');
}

/**
 * Builds strict CORS headers following Supabase Edge Function CORS guidance.
 * Never falls back to wildcard `*`: only explicit origins configured in
 * `MASAR_CORS_ALLOWED_ORIGINS` are echoed with `Vary: Origin`.
 */
export function buildStaffProvisioningCorsHeaders(
  requestOrigin?: string | null,
  allowedOriginsEnv?: string
): Record<string, string> {
  const configured = parseAllowedOrigins(allowedOriginsEnv);
  const cleanOrigin = (requestOrigin ?? '').trim();
  const isAllowed =
    configured.length > 0 && cleanOrigin.length > 0 && configured.includes(cleanOrigin);

  return {
    'Access-Control-Allow-Origin': isAllowed ? cleanOrigin : 'null',
    'Access-Control-Allow-Headers': DEFAULT_CORS_ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IRAQI_PHONE_RE = /^07[3-9][0-9]{8}$/;

export function normalizeIraqiPhoneStrict(raw: string): string {
  const digits = raw.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+964')) {
    return `0${digits.slice(4)}`;
  }
  if (digits.startsWith('00964')) {
    return `0${digits.slice(5)}`;
  }
  return digits;
}

export function validateStrongPassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < 12) {
    return 'Password must be at least 12 characters long.';
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include uppercase, lowercase, and numeric characters.';
  }
  return null;
}

/**
 * Constant-time equality over SHA-256 digests so secret length differences do not leak timing.
 */
export async function constantTimeSecretEqual(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    globalThis.crypto.subtle.digest('SHA-256', enc.encode(a)),
    globalThis.crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  let diff = bytesA.length ^ bytesB.length;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

function getHeaderCaseInsensitive(headers: Headers, target: string): string {
  const direct = headers.get(target);
  if (direct !== null) return direct;
  const lower = target.toLowerCase();
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === lower) return v;
  }
  return '';
}

function extractBearerToken(headers: Headers): string {
  const auth = getHeaderCaseInsensitive(headers, 'authorization').trim();
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

export async function handleBootstrapFirstOwner(params: {
  method: string;
  headers: Headers;
  rawBody: unknown;
  env: ProvisioningEnv;
  adminClient: AdminSupabaseLike;
}): Promise<ProvisioningResponse> {
  if (params.method !== 'POST') {
    return { status: 405, body: { ok: false, errorCode: 'METHOD_NOT_ALLOWED' } };
  }

  // H4: Require BOTH MASAR_BOOTSTRAP_TOKEN (>= 32 chars) AND a dedicated
  // MASAR_PLATFORM_ADMIN_TOKEN (>= 32 chars). Never accept SUPABASE_SERVICE_ROLE_KEY
  // as an HTTP request bearer credential.
  const configuredBootstrapToken = (params.env.bootstrapToken ?? '').trim();
  const configuredAdminToken = (params.env.platformAdminToken ?? '').trim();
  if (configuredBootstrapToken.length < 32 || configuredAdminToken.length < 32) {
    return {
      status: 503,
      body: {
        ok: false,
        errorCode: 'BOOTSTRAP_DISABLED',
        message:
          'First-owner bootstrap is disabled until both MASAR_BOOTSTRAP_TOKEN (>= 32 chars) and MASAR_PLATFORM_ADMIN_TOKEN (>= 32 chars) are configured.',
      },
    };
  }

  const suppliedBootstrapToken = getHeaderCaseInsensitive(
    params.headers,
    'x-masar-bootstrap-token'
  ).trim();
  if (!(await constantTimeSecretEqual(suppliedBootstrapToken, configuredBootstrapToken))) {
    return {
      status: 401,
      body: {
        ok: false,
        errorCode: 'UNAUTHORIZED_BOOTSTRAP_TOKEN',
        message: 'Invalid or missing X-Masar-Bootstrap-Token header.',
      },
    };
  }

  const suppliedAdminBearer = extractBearerToken(params.headers);
  if (!(await constantTimeSecretEqual(suppliedAdminBearer, configuredAdminToken))) {
    return {
      status: 401,
      body: {
        ok: false,
        errorCode: 'UNAUTHORIZED_PLATFORM_ADMIN',
        message: 'Missing or invalid MASAR_PLATFORM_ADMIN_TOKEN bearer credential.',
      },
    };
  }

  if (!params.rawBody || typeof params.rawBody !== 'object') {
    return {
      status: 400,
      body: { ok: false, errorCode: 'INVALID_REQUEST_BODY', message: 'JSON object body required.' },
    };
  }

  const body = params.rawBody as Record<string, unknown>;
  const headerIdempotencyKey = getHeaderCaseInsensitive(params.headers, 'idempotency-key').trim();
  const bodyIdempotencyKey =
    typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  const idempotencyKey = headerIdempotencyKey || bodyIdempotencyKey;

  if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
    return {
      status: 400,
      body: {
        ok: false,
        errorCode: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency-Key header (or idempotencyKey field, 16-128 characters) is required for bootstrap.',
      },
    };
  }

  const pharmacy = (body.pharmacy ?? {}) as Record<string, unknown>;
  const owner = (body.owner ?? {}) as Record<string, unknown>;

  const nameAr = String(pharmacy.nameAr ?? '').trim();
  const nameEn = String(pharmacy.nameEn ?? '').trim();
  const city = String(pharmacy.city ?? '').trim();
  const governorate = String(pharmacy.governorate ?? '').trim();
  const licenseNumber = String(pharmacy.licenseNumber ?? '').trim();
  const pharmacyPhone = normalizeIraqiPhoneStrict(String(pharmacy.phone ?? '').trim());

  const ownerEmail = String(owner.email ?? '').trim().toLowerCase();
  const ownerPassword = String(owner.password ?? '');
  const ownerFullName = String(owner.fullName ?? '').trim();
  const ownerPhone = normalizeIraqiPhoneStrict(String(owner.phone ?? '').trim());
  const syndicateLicense = String(owner.syndicateLicense ?? '').trim();

  if (
    nameAr.length < 2 ||
    nameEn.length < 2 ||
    city.length < 2 ||
    governorate.length < 2 ||
    licenseNumber.length < 3
  ) {
    return {
      status: 400,
      body: {
        ok: false,
        errorCode: 'INVALID_PHARMACY_FIELDS',
        message: 'Pharmacy nameAr, nameEn, city, governorate, and licenseNumber are required.',
      },
    };
  }

  if (!IRAQI_PHONE_RE.test(pharmacyPhone) || !IRAQI_PHONE_RE.test(ownerPhone)) {
    return {
      status: 400,
      body: {
        ok: false,
        errorCode: 'INVALID_IRAQI_PHONE',
        message: 'Pharmacy and owner phone numbers must match Iraqi 07[3-9]XXXXXXXX format.',
      },
    };
  }

  if (!EMAIL_RE.test(ownerEmail) || ownerFullName.length < 3) {
    return {
      status: 400,
      body: {
        ok: false,
        errorCode: 'INVALID_OWNER_PROFILE',
        message: 'Valid owner email and fullName (>= 3 characters) are required.',
      },
    };
  }

  const pwError = validateStrongPassword(ownerPassword);
  if (pwError) {
    return {
      status: 400,
      body: { ok: false, errorCode: 'WEAK_PASSWORD', message: pwError },
    };
  }

  // H3: Acquire durable cross-service bootstrap claim BEFORE creating Auth user
  const requestId = globalThis.crypto.randomUUID();
  const claimRes = await params.adminClient.rpc('claim_first_owner_bootstrap', {
    p_idempotency_key: idempotencyKey,
    p_request_id: requestId,
    p_claim_ttl_seconds: 120,
  });

  if (claimRes.error) {
    return {
      status: 500,
      body: {
        ok: false,
        errorCode: 'BOOTSTRAP_GATE_ERROR',
        message: claimRes.error.message,
      },
    };
  }

  const claimPayload = (claimRes.data ?? null) as {
    ok?: boolean;
    errorCode?: string;
    claimId?: string;
    orphanAuthUserId?: string;
    lastError?: string;
  } | null;

  if (!claimPayload || typeof claimPayload !== 'object' || typeof claimPayload.ok !== 'boolean') {
    return {
      status: 500,
      body: {
        ok: false,
        errorCode: 'BOOTSTRAP_GATE_ERROR',
        message: 'Malformed response from claim_first_owner_bootstrap.',
      },
    };
  }

  if (claimPayload.ok === false) {
    return {
      status: 409,
      body: {
        ok: false,
        errorCode: claimPayload.errorCode ?? 'BOOTSTRAP_ALREADY_COMPLETED',
        orphanAuthUserId: claimPayload.orphanAuthUserId,
        message:
          claimPayload.errorCode === 'BOOTSTRAP_IN_PROGRESS'
            ? 'Another bootstrap request holds an active claim.'
            : claimPayload.errorCode === 'BOOTSTRAP_NEEDS_RECONCILIATION'
              ? 'Bootstrap state requires operator reconciliation before retry.'
              : 'Bootstrap has already been completed or pharmacy records already exist.',
      },
    };
  }

  if (claimPayload.claimId !== requestId) {
    return {
      status: 500,
      body: {
        ok: false,
        errorCode: 'BOOTSTRAP_GATE_ERROR',
        message: 'Claim response claimId mismatch.',
      },
    };
  }

  const createdAuth = await params.adminClient.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true,
  });

  if (createdAuth.error || !createdAuth.data.user?.id) {
    await params.adminClient.rpc('mark_first_owner_bootstrap_reconciliation', {
      p_request_id: requestId,
      p_new_status: 'pending',
      p_orphan_auth_user_id: null,
      p_error: createdAuth.error?.message ?? 'Auth createUser failed before DB finalization',
    });
    return {
      status: 400,
      body: {
        ok: false,
        errorCode: 'AUTH_USER_CREATION_FAILED',
        message: createdAuth.error?.message ?? 'Unable to create owner authentication user.',
      },
    };
  }

  const createdUserId = createdAuth.data.user.id;
  const finRes = await params.adminClient.rpc('finalize_first_owner_bootstrap', {
    p_request_id: requestId,
    p_owner_user_id: createdUserId,
    p_pharmacy_name_ar: nameAr,
    p_pharmacy_name_en: nameEn,
    p_city: city,
    p_governorate: governorate,
    p_license_number: licenseNumber,
    p_pharmacy_phone: pharmacyPhone,
    p_owner_full_name: ownerFullName,
    p_owner_phone: ownerPhone,
    p_syndicate_license: syndicateLicense || null,
  });

  const finPayload = (finRes.data ?? null) as {
    ok?: unknown;
    errorCode?: unknown;
    pharmacyId?: unknown;
    ownerUserId?: unknown;
  } | null;

  // H6: Fail closed unless RPC returned complete schema-validated success payload
  const isValidFinalizeSuccess =
    !finRes.error &&
    finPayload !== null &&
    typeof finPayload === 'object' &&
    finPayload.ok === true &&
    isNonEmptyString(finPayload.pharmacyId) &&
    finPayload.ownerUserId === createdUserId;

  if (isValidFinalizeSuccess) {
    return {
      status: 201,
      body: {
        ok: true,
        pharmacyId: finPayload.pharmacyId,
        ownerUserId: createdUserId,
        role: 'pharmacy_owner',
        reminder:
          'Delete bootstrap-first-owner Edge Function and unset MASAR_BOOTSTRAP_TOKEN + MASAR_PLATFORM_ADMIN_TOKEN immediately after verification.',
      },
    };
  }

  // H3: Before ANY Auth user deletion after an ambiguous/error/malformed finalize outcome,
  // inspect durable database state so we never delete an Auth user whose DB transaction actually committed.
  const inspectRes = await params.adminClient.rpc('inspect_first_owner_bootstrap_state');
  const inspectData = (inspectRes.data ?? null) as {
    status?: unknown;
    pharmacyId?: unknown;
    ownerUserId?: unknown;
    pharmacyCount?: unknown;
    staffCount?: unknown;
  } | null;

  const inspectValid =
    !inspectRes.error &&
    inspectData !== null &&
    typeof inspectData === 'object' &&
    typeof inspectData.status === 'string';

  if (!inspectValid) {
    const errText = `Finalize error/malformed (${
      finRes.error?.message ?? String(finPayload?.errorCode ?? 'MALFORMED_RPC_RESPONSE')
    }) and inspect_first_owner_bootstrap_state failed (${inspectRes.error?.message ?? 'invalid payload'}). Auth user NOT deleted pending manual inspection.`;

    await params.adminClient.rpc('mark_first_owner_bootstrap_reconciliation', {
      p_request_id: requestId,
      p_new_status: 'failed_needs_reconciliation',
      p_orphan_auth_user_id: createdUserId,
      p_error: errText,
    });

    return {
      status: 500,
      body: {
        ok: false,
        errorCode: 'RECONCILIATION_REQUIRED',
        authUserId: createdUserId,
        message: errText,
      },
    };
  }

  // Case A: DB actually committed for THIS createdUserId! Preserve Auth user and return reconciled 201.
  if (
    inspectData.status === 'completed' &&
    inspectData.ownerUserId === createdUserId &&
    isNonEmptyString(inspectData.pharmacyId)
  ) {
    return {
      status: 201,
      body: {
        ok: true,
        pharmacyId: inspectData.pharmacyId,
        ownerUserId: createdUserId,
        role: 'pharmacy_owner',
        reconciledFromAmbiguousFinalize: true,
        reminder:
          'Delete bootstrap-first-owner Edge Function and unset MASAR_BOOTSTRAP_TOKEN + MASAR_PLATFORM_ADMIN_TOKEN immediately after verification.',
      },
    };
  }

  // Case B: DB completed by a DIFFERENT concurrent owner -> safe to roll back this loser Auth user.
  if (inspectData.status === 'completed' && inspectData.ownerUserId !== createdUserId) {
    const rollbackRes = await params.adminClient.auth.admin.deleteUser(createdUserId);
    if (rollbackRes.error) {
      return {
        status: 500,
        body: {
          ok: false,
          errorCode: 'RECONCILIATION_REQUIRED',
          orphanAuthUserId: createdUserId,
          message: `Concurrent bootstrap completed by another owner and Auth rollback failed (${rollbackRes.error.message}).`,
        },
      };
    }
    return {
      status: 409,
      body: {
        ok: false,
        errorCode: 'BOOTSTRAP_ALREADY_COMPLETED',
        message: 'Concurrent bootstrap already completed; Auth user cleanly rolled back.',
      },
    };
  }

  // Case C: Durable state proves DB has 0 pharmacies, 0 staff, and status !== 'completed' -> safe to roll back Auth user.
  const dbConfirmedUntouched =
    inspectData.status !== 'completed' &&
    inspectData.pharmacyCount === 0 &&
    inspectData.staffCount === 0 &&
    !inspectData.ownerUserId;

  if (!dbConfirmedUntouched) {
    const errText =
      'Bootstrap finalize failed/returned malformed payload and durable DB state is partially populated. Auth user preserved for manual reconciliation.';
    await params.adminClient.rpc('mark_first_owner_bootstrap_reconciliation', {
      p_request_id: requestId,
      p_new_status: 'failed_needs_reconciliation',
      p_orphan_auth_user_id: createdUserId,
      p_error: errText,
    });
    return {
      status: 500,
      body: {
        ok: false,
        errorCode: 'RECONCILIATION_REQUIRED',
        authUserId: createdUserId,
        message: errText,
      },
    };
  }

  const rollbackRes = await params.adminClient.auth.admin.deleteUser(createdUserId);
  if (rollbackRes.error) {
    await params.adminClient.rpc('mark_first_owner_bootstrap_reconciliation', {
      p_request_id: requestId,
      p_new_status: 'failed_needs_reconciliation',
      p_orphan_auth_user_id: createdUserId,
      p_error: rollbackRes.error.message,
    });
    return {
      status: 500,
      body: {
        ok: false,
        errorCode: 'RECONCILIATION_REQUIRED',
        orphanAuthUserId: createdUserId,
        message: `Bootstrap finalization failed and Auth rollback failed (${rollbackRes.error.message}).`,
      },
    };
  }

  await params.adminClient.rpc('mark_first_owner_bootstrap_reconciliation', {
    p_request_id: requestId,
    p_new_status: 'pending',
    p_orphan_auth_user_id: null,
    p_error: null,
  });

  if (finPayload?.errorCode === 'BOOTSTRAP_ALREADY_COMPLETED') {
    return {
      status: 409,
      body: {
        ok: false,
        errorCode: 'BOOTSTRAP_ALREADY_COMPLETED',
        message: 'Bootstrap already completed; Auth user cleanly rolled back.',
      },
    };
  }

  if (!finRes.error && (!finPayload || finPayload.ok !== false)) {
    return {
      status: 500,
      body: {
        ok: false,
        errorCode: 'RECONCILIATION_REQUIRED',
        message:
          'finalize_first_owner_bootstrap returned malformed/mismatched response payload; verified DB untouched and rolled back Auth user.',
      },
    };
  }

  return {
    status: finRes.error?.code === '23505' ? 409 : 500,
    body: {
      ok: false,
      errorCode:
        typeof finPayload?.errorCode === 'string'
          ? finPayload.errorCode
          : 'BOOTSTRAP_FINALIZE_FAILED',
      message: finRes.error?.message ?? 'Bootstrap finalization failed; Auth user rolled back.',
    },
  };
}

export async function handleOwnerProvisionStaff(params: {
  method: string;
  headers: Headers;
  rawBody: unknown;
  adminClient: AdminSupabaseLike;
  allowedOrigins?: string;
  requireAllowlist?: boolean;
}): Promise<ProvisioningResponse> {
  const requestOrigin = getHeaderCaseInsensitive(params.headers, 'origin').trim() || null;
  const configuredOrigins = parseAllowedOrigins(params.allowedOrigins);
  const corsHeaders = buildStaffProvisioningCorsHeaders(requestOrigin, params.allowedOrigins);
  const respond = (status: number, body: Record<string, unknown>): ProvisioningResponse => ({
    status,
    body,
    headers: corsHeaders,
  });

  if (params.requireAllowlist && configuredOrigins.length === 0) {
    return respond(500, {
      ok: false,
      errorCode: 'CORS_ALLOWLIST_NOT_CONFIGURED',
      message:
        'MASAR_CORS_ALLOWED_ORIGINS must be configured with explicit allowed origins (never wildcard *).',
    });
  }

  if (requestOrigin && !configuredOrigins.includes(requestOrigin)) {
    return respond(403, {
      ok: false,
      errorCode: 'CORS_ORIGIN_FORBIDDEN',
      message: 'Request Origin is not in the configured MASAR_CORS_ALLOWED_ORIGINS allowlist.',
    });
  }

  if (params.method === 'OPTIONS') {
    return respond(200, { ok: true, preflight: true });
  }

  if (params.method !== 'POST') {
    return respond(405, { ok: false, errorCode: 'METHOD_NOT_ALLOWED' });
  }

  const jwt = extractBearerToken(params.headers);
  if (!jwt) {
    return respond(401, {
      ok: false,
      errorCode: 'MISSING_BEARER_TOKEN',
      message: 'Pharmacist session JWT required.',
    });
  }

  const callerAuth = await params.adminClient.auth.getUser(jwt);
  if (callerAuth.error || !callerAuth.data.user?.id) {
    return respond(401, {
      ok: false,
      errorCode: 'INVALID_CALLER_SESSION',
      message: callerAuth.error?.message ?? 'Invalid or expired caller session.',
    });
  }

  const callerId = callerAuth.data.user.id;
  const staffRes = await params.adminClient
    .from('pharmacy_staff')
    .select('id, pharmacy_id, full_name, role, is_active')
    .eq('id', callerId)
    .maybeSingle();

  if (staffRes.error) {
    return respond(500, {
      ok: false,
      errorCode: 'STAFF_LOOKUP_FAILED',
      message: staffRes.error.message,
    });
  }
  if (!staffRes.data) {
    return respond(403, {
      ok: false,
      errorCode: 'CALLER_NOT_PHARMACY_STAFF',
      message: 'Authenticated user is not registered in pharmacy_staff.',
    });
  }
  if (staffRes.data.is_active !== true) {
    return respond(403, {
      ok: false,
      errorCode: 'CALLER_STAFF_INACTIVE',
      message: 'Inactive staff accounts cannot provision other pharmacy staff.',
    });
  }
  if (staffRes.data.role !== 'pharmacy_owner') {
    return respond(403, {
      ok: false,
      errorCode: 'OWNER_ROLE_REQUIRED',
      message: 'Only an active pharmacy_owner may provision new staff accounts.',
    });
  }

  const ownerPharmacyId = String(staffRes.data.pharmacy_id);
  const pharmacyRes = await params.adminClient
    .from('pharmacies')
    .select('id, is_active')
    .eq('id', ownerPharmacyId)
    .maybeSingle();

  if (pharmacyRes.error) {
    return respond(500, {
      ok: false,
      errorCode: 'PHARMACY_LOOKUP_FAILED',
      message: pharmacyRes.error.message,
    });
  }
  if (!pharmacyRes.data || pharmacyRes.data.is_active !== true) {
    return respond(403, {
      ok: false,
      errorCode: 'PHARMACY_INACTIVE',
      message: 'Pharmacy is inactive or missing.',
    });
  }

  if (!params.rawBody || typeof params.rawBody !== 'object') {
    return respond(400, {
      ok: false,
      errorCode: 'INVALID_REQUEST_BODY',
      message: 'JSON object body required.',
    });
  }

  const body = params.rawBody as Record<string, unknown>;
  const headerIdempotencyKey = getHeaderCaseInsensitive(params.headers, 'idempotency-key').trim();
  const bodyIdempotencyKey =
    typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  const idempotencyKey = headerIdempotencyKey || bodyIdempotencyKey;

  if (idempotencyKey.length < 16 || idempotencyKey.length > 128) {
    return respond(400, {
      ok: false,
      errorCode: 'INVALID_IDEMPOTENCY_KEY',
      message:
        'Idempotency-Key header (or idempotencyKey field, 16-128 characters) is required for staff provisioning.',
    });
  }

  const requestedPharmacyId =
    typeof body.pharmacyId === 'string' ? body.pharmacyId.trim() : '';
  if (requestedPharmacyId && requestedPharmacyId !== ownerPharmacyId) {
    return respond(403, {
      ok: false,
      errorCode: 'CROSS_PHARMACY_FORBIDDEN',
      message: 'pharmacy_owner cannot provision staff for another pharmacy.',
    });
  }

  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const fullName = String(body.fullName ?? '').trim();
  const phone = normalizeIraqiPhoneStrict(String(body.phone ?? '').trim());
  const role = String(body.role ?? 'authorized_pharmacist').trim();
  const syndicateLicense = String(body.syndicateLicense ?? '').trim();

  if (!EMAIL_RE.test(email) || fullName.length < 3) {
    return respond(400, {
      ok: false,
      errorCode: 'INVALID_STAFF_PROFILE',
      message: 'Valid staff email and fullName (>= 3 characters) are required.',
    });
  }

  // H5: Restrict ordinary staff provisioning strictly to `authorized_pharmacist`.
  if (role === 'pharmacy_owner') {
    return respond(403, {
      ok: false,
      errorCode: 'OWNER_DELEGATION_NOT_ENABLED',
      message:
        'Creating additional pharmacy_owner accounts is disabled via owner-provision-staff. Only authorized_pharmacist staff may be provisioned.',
    });
  }

  if (role !== 'authorized_pharmacist') {
    return respond(400, {
      ok: false,
      errorCode: 'INVALID_STAFF_ROLE',
      message: 'Role must be authorized_pharmacist.',
    });
  }

  if (!IRAQI_PHONE_RE.test(phone)) {
    return respond(400, {
      ok: false,
      errorCode: 'INVALID_IRAQI_PHONE',
      message: 'Staff phone number must match Iraqi 07[3-9]XXXXXXXX format.',
    });
  }

  const pwError = validateStrongPassword(password);
  if (pwError) {
    return respond(400, { ok: false, errorCode: 'WEAK_PASSWORD', message: pwError });
  }

  const existingPhone = await params.adminClient
    .from('pharmacy_staff')
    .select('id')
    .eq('pharmacy_id', ownerPharmacyId)
    .eq('phone', phone)
    .maybeSingle();

  if (existingPhone.error) {
    return respond(500, {
      ok: false,
      errorCode: 'DUPLICATE_CHECK_FAILED',
      message: existingPhone.error.message,
    });
  }
  if (existingPhone.data) {
    return respond(409, {
      ok: false,
      errorCode: 'DUPLICATE_STAFF_RECORD',
      message: 'A staff account with this phone number already exists in your pharmacy.',
    });
  }

  if (syndicateLicense) {
    const existingSyn = await params.adminClient
      .from('pharmacy_staff')
      .select('id')
      .eq('syndicate_license', syndicateLicense)
      .maybeSingle();
    if (existingSyn.error) {
      return respond(500, {
        ok: false,
        errorCode: 'DUPLICATE_CHECK_FAILED',
        message: existingSyn.error.message,
      });
    }
    if (existingSyn.data) {
      return respond(409, {
        ok: false,
        errorCode: 'DUPLICATE_STAFF_RECORD',
        message: 'A staff account with this syndicate license already exists.',
      });
    }
  }

  // Stage 2B.2A.3: Acquire immutable canonical staff provisioning claim BEFORE creating Auth user
  const requestId = globalThis.crypto.randomUUID();
  const claimRes = await params.adminClient.rpc('claim_staff_provisioning_request', {
    p_owner_user_id: callerId,
    p_idempotency_key: idempotencyKey,
    p_request_id: requestId,
    p_target_email: email,
    p_target_phone: phone,
    p_target_role: 'authorized_pharmacist',
    p_claim_ttl_seconds: 120,
  });

  if (claimRes.error) {
    return respond(500, {
      ok: false,
      errorCode: 'STAFF_PROVISIONING_GATE_ERROR',
      message: claimRes.error.message,
    });
  }

  const claimPayload = (claimRes.data ?? null) as {
    ok?: unknown;
    errorCode?: unknown;
    claimId?: unknown;
    staffId?: unknown;
    pharmacyId?: unknown;
    role?: unknown;
    orphanAuthUserId?: unknown;
    lastError?: unknown;
  } | null;

  if (!claimPayload || typeof claimPayload !== 'object' || typeof claimPayload.ok !== 'boolean') {
    return respond(500, {
      ok: false,
      errorCode: 'STAFF_PROVISIONING_GATE_ERROR',
      message: 'Malformed response from claim_staff_provisioning_request.',
    });
  }

  if (claimPayload.ok === false) {
    return respond(409, {
      ok: false,
      errorCode:
        typeof claimPayload.errorCode === 'string'
          ? claimPayload.errorCode
          : 'STAFF_PROVISIONING_CONFLICT',
      staffId: claimPayload.staffId,
      pharmacyId: claimPayload.pharmacyId,
      orphanAuthUserId: claimPayload.orphanAuthUserId,
      message:
        claimPayload.errorCode === 'STAFF_IDEMPOTENCY_KEY_CONFLICT'
          ? 'This Idempotency-Key is already bound to a different staff provisioning request payload.'
          : claimPayload.errorCode === 'STAFF_CLAIM_EXPIRED_RECONCILIATION_REQUIRED'
            ? 'Prior provisioning claim TTL expired; Auth and database reconciliation is required before retry.'
            : claimPayload.errorCode === 'STAFF_PROVISIONING_IN_PROGRESS'
              ? 'Another staff provisioning request with this Idempotency-Key is currently in progress.'
              : claimPayload.errorCode === 'STAFF_PROVISIONING_NEEDS_RECONCILIATION'
                ? 'Previous staff provisioning attempt for this Idempotency-Key requires manual reconciliation.'
                : 'Staff provisioning for this Idempotency-Key has already completed.',
    });
  }

  if (claimPayload.claimId !== requestId) {
    return respond(500, {
      ok: false,
      errorCode: 'STAFF_PROVISIONING_GATE_ERROR',
      message: 'Staff provisioning claimId mismatch.',
    });
  }

  const createdAuth = await params.adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createdAuth.error || !createdAuth.data.user?.id) {
    const msg = createdAuth.error?.message ?? 'Failed to create staff Auth user.';
    const isDuplicateEmail = /already|registered|exists/i.test(msg);
    await params.adminClient.rpc('mark_staff_provisioning_reconciliation', {
      p_request_id: requestId,
      p_new_status: 'rolled_back',
      p_orphan_auth_user_id: null,
      p_error: msg,
    });
    return respond(isDuplicateEmail ? 409 : 400, {
      ok: false,
      errorCode: isDuplicateEmail ? 'DUPLICATE_STAFF_EMAIL' : 'AUTH_USER_CREATION_FAILED',
      message: msg,
    });
  }

  const newStaffUserId = createdAuth.data.user.id;
  const provRes = await params.adminClient.rpc('provision_pharmacy_staff_by_owner', {
    p_owner_user_id: callerId,
    p_new_user_id: newStaffUserId,
    p_full_name: fullName,
    p_role: 'authorized_pharmacist',
    p_phone: phone,
    p_syndicate_license: syndicateLicense || null,
    p_request_id: requestId,
  });

  const provPayload = (provRes.data ?? null) as {
    ok?: unknown;
    staffId?: unknown;
    pharmacyId?: unknown;
    role?: unknown;
  } | null;

  // H6: Fail closed unless RPC returns schema-validated `{ ok: true, staffId, pharmacyId, role }`
  const isValidProvisionSuccess =
    !provRes.error &&
    provPayload !== null &&
    typeof provPayload === 'object' &&
    provPayload.ok === true &&
    provPayload.staffId === newStaffUserId &&
    provPayload.pharmacyId === ownerPharmacyId &&
    provPayload.role === 'authorized_pharmacist';

  if (isValidProvisionSuccess) {
    return respond(201, {
      ok: true,
      staffId: newStaffUserId,
      pharmacyId: ownerPharmacyId,
      role: 'authorized_pharmacist',
      requestId,
    });
  }

  // Stage 2B.2A.2 H4: Never delete the Auth user after an ambiguous/error/malformed RPC
  // result without first inspecting durable DB state to verify whether `pharmacy_staff` committed.
  const inspectRes = await params.adminClient.rpc('inspect_staff_provisioning_state', {
    p_owner_user_id: callerId,
    p_request_id: requestId,
    p_staff_user_id: newStaffUserId,
  });
  const inspectData = (inspectRes.data ?? null) as {
    status?: unknown;
    pharmacyId?: unknown;
    staffExistsInDb?: unknown;
    staffId?: unknown;
    staffRole?: unknown;
  } | null;

  const inspectValid =
    !inspectRes.error &&
    inspectData !== null &&
    typeof inspectData === 'object' &&
    typeof inspectData.staffExistsInDb === 'boolean';

  if (!inspectValid) {
    const errText = `Staff provisioning RPC failed/malformed (${
      provRes.error?.message ?? 'MALFORMED_RPC_RESPONSE'
    }) and inspect_staff_provisioning_state failed (${
      inspectRes.error?.message ?? 'invalid payload'
    }). Auth user NOT deleted pending manual inspection.`;

    await params.adminClient.rpc('mark_staff_provisioning_reconciliation', {
      p_request_id: requestId,
      p_new_status: 'failed_needs_reconciliation',
      p_orphan_auth_user_id: newStaffUserId,
      p_error: errText,
    });

    return respond(500, {
      ok: false,
      errorCode: 'RECONCILIATION_REQUIRED',
      authUserId: newStaffUserId,
      requestId,
      message: errText,
    });
  }

  // Case A: DB actually committed the staff row! Preserve Auth user and return reconciled 201.
  if (
    inspectData.staffExistsInDb === true &&
    inspectData.pharmacyId === ownerPharmacyId &&
    inspectData.staffId === newStaffUserId
  ) {
    return respond(201, {
      ok: true,
      staffId: newStaffUserId,
      pharmacyId: ownerPharmacyId,
      role: 'authorized_pharmacist',
      requestId,
      reconciledFromAmbiguousProvisioning: true,
    });
  }

  // Case B: Durable DB state confirms `pharmacy_staff` row was NOT created -> safe to roll back Auth user.
  const rollbackRes = await params.adminClient.auth.admin.deleteUser(newStaffUserId);
  if (rollbackRes.error) {
    const errText = `Staff DB provisioning failed/mismatched (${
      provRes.error?.message ?? 'MALFORMED_RPC_RESPONSE'
    }) and Auth rollback failed (${rollbackRes.error.message}).`;
    await params.adminClient.rpc('mark_staff_provisioning_reconciliation', {
      p_request_id: requestId,
      p_new_status: 'failed_needs_reconciliation',
      p_orphan_auth_user_id: newStaffUserId,
      p_error: errText,
    });
    return respond(500, {
      ok: false,
      errorCode: 'RECONCILIATION_REQUIRED',
      orphanAuthUserId: newStaffUserId,
      requestId,
      message: errText,
    });
  }

  await params.adminClient.rpc('mark_staff_provisioning_reconciliation', {
    p_request_id: requestId,
    p_new_status: 'rolled_back',
    p_orphan_auth_user_id: null,
    p_error: null,
  });

  if (provRes.error?.code === '23505') {
    return respond(409, {
      ok: false,
      errorCode: 'DUPLICATE_STAFF_RECORD',
      message: 'Duplicate phone or syndicate license detected; Auth user cleanly rolled back.',
    });
  }

  if (provRes.error?.code === '42501') {
    return respond(403, {
      ok: false,
      errorCode: 'OWNER_AUTHORIZATION_DENIED',
      message: provRes.error.message,
    });
  }

  if (!provRes.error) {
    return respond(500, {
      ok: false,
      errorCode: 'RECONCILIATION_REQUIRED',
      message:
        'provision_pharmacy_staff_by_owner returned malformed or mismatched payload; verified DB untouched and rolled back Auth user.',
    });
  }

  return respond(500, {
    ok: false,
    errorCode: 'STAFF_PROVISIONING_FAILED',
    message: `${provRes.error.message}; verified DB untouched and Auth user cleanly rolled back.`,
  });
}

const HTTP_JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

/**
 * Full Edge HTTP request wrapper (shared between Deno entrypoint & Node HTTP tests):
 * enforces MASAR_CORS_ALLOWED_ORIGINS allowlist, handles anonymous browser OPTIONS
 * preflight after origin validation, rejects malformed JSON safely with CORS headers,
 * and delegates to handleOwnerProvisionStaff for mandatory JWT + pharmacy_owner verification.
 */
export async function handleOwnerProvisionStaffHttpRequest(params: {
  req: Request;
  adminClient: AdminSupabaseLike | null;
  allowedOrigins?: string;
  requireAllowlist?: boolean;
}): Promise<Response> {
  const origin = getHeaderCaseInsensitive(params.req.headers, 'origin').trim() || null;
  const corsHeaders = buildStaffProvisioningCorsHeaders(origin, params.allowedOrigins);
  const configuredOrigins = parseAllowedOrigins(params.allowedOrigins);
  const requireAllowlist = params.requireAllowlist ?? true;

  if (requireAllowlist && configuredOrigins.length === 0) {
    return new Response(
      JSON.stringify({
        ok: false,
        errorCode: 'CORS_ALLOWLIST_NOT_CONFIGURED',
        message:
          'MASAR_CORS_ALLOWED_ORIGINS must be configured with explicit allowed origins.',
      }),
      { status: 500, headers: { ...HTTP_JSON_HEADERS, ...corsHeaders } }
    );
  }

  if (origin && !configuredOrigins.includes(origin)) {
    return new Response(
      JSON.stringify({
        ok: false,
        errorCode: 'CORS_ORIGIN_FORBIDDEN',
        message: 'Request Origin is not in the configured MASAR_CORS_ALLOWED_ORIGINS allowlist.',
      }),
      { status: 403, headers: { ...HTTP_JSON_HEADERS, ...corsHeaders } }
    );
  }

  if (params.req.method === 'OPTIONS') {
    return new Response('ok', {
      status: 200,
      headers: { ...corsHeaders, 'Cache-Control': 'no-store' },
    });
  }

  if (!params.adminClient) {
    return new Response(
      JSON.stringify({
        ok: false,
        errorCode: 'SERVER_MISCONFIGURED',
        message: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.',
      }),
      { status: 500, headers: { ...HTTP_JSON_HEADERS, ...corsHeaders } }
    );
  }

  let rawBody: unknown = null;
  if (params.req.method === 'POST') {
    try {
      rawBody = await params.req.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, errorCode: 'INVALID_JSON', message: 'Malformed JSON body.' }),
        { status: 400, headers: { ...HTTP_JSON_HEADERS, ...corsHeaders } }
      );
    }
  }

  const result = await handleOwnerProvisionStaff({
    method: params.req.method,
    headers: params.req.headers,
    rawBody,
    adminClient: params.adminClient,
    allowedOrigins: params.allowedOrigins,
    requireAllowlist,
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...HTTP_JSON_HEADERS, ...(result.headers ?? corsHeaders) },
  });
}
