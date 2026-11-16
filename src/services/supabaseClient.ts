import { createClient, SupabaseClient } from '@supabase/supabase-js';

export type EnvRecord = Record<string, string | boolean | undefined>;

export type SupabaseConfigErrorCode =
  | 'CONNECTED_MODE_DISABLED'
  | 'MISSING_SUPABASE_URL'
  | 'INVALID_SUPABASE_URL'
  | 'MISSING_PUBLISHABLE_KEY'
  | 'FORBIDDEN_SECRET_KEY';

export interface SupabaseConfigStatus {
  connectedModeEnabled: boolean;
  isConfigured: boolean;
  hasUrl: boolean;
  hasPublishableKey: boolean;
  urlHost: string | null;
  errorCode: SupabaseConfigErrorCode | null;
  errorMessage: string | null;
}

function readViteEnv(): EnvRecord {
  const metaEnv = (import.meta as { env?: EnvRecord }).env;
  if (metaEnv && typeof metaEnv === 'object') {
    return metaEnv;
  }
  return {};
}

function readStringEnv(env: EnvRecord, key: string): string {
  const raw = env[key];
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function decodeBase64UrlSegment(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLength);
    if (typeof atob === 'function') {
      return atob(padded);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('utf8');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Browser security guard: rejects Supabase secret keys (`sb_secret_*`) and
 * JWT keys whose payload declares `role === 'service_role'`.
 * Never logs or echoes the inspected key value.
 */
export function isForbiddenSecretKey(candidateKey: string): boolean {
  const trimmed = candidateKey.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('sb_secret_')) return true;

  const parts = trimmed.split('.');
  if (parts.length === 3) {
    const decoded = decodeBase64UrlSegment(parts[1]);
    if (decoded) {
      try {
        const parsed = JSON.parse(decoded) as { role?: unknown };
        if (parsed && parsed.role === 'service_role') {
          return true;
        }
      } catch {
        // Non-JSON payload is handled as ordinary opaque key
      }
    }
  }
  return false;
}

function parseSafeSupabaseUrl(rawUrl: string): { valid: boolean; host: string | null } {
  if (!rawUrl) return { valid: false, host: null };
  try {
    const parsed = new URL(rawUrl);
    const isHttps = parsed.protocol === 'https:';
    const isLocalHttp =
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (!isHttps && !isLocalHttp) {
      return { valid: false, host: null };
    }
    return { valid: true, host: parsed.host };
  } catch {
    return { valid: false, host: null };
  }
}

/**
 * Connected Mode is OFF by default and activates ONLY when
 * `VITE_ENABLE_SUPABASE_CRM` is explicitly set to `"true"`.
 */
export function isConnectedModeEnabled(envOverride?: EnvRecord): boolean {
  const env = envOverride ?? readViteEnv();
  return readStringEnv(env, 'VITE_ENABLE_SUPABASE_CRM').toLowerCase() === 'true';
}

/**
 * Returns credential-safe Supabase runtime configuration status (never exposes keys).
 */
export function getSupabaseConfigStatus(envOverride?: EnvRecord): SupabaseConfigStatus {
  const env = envOverride ?? readViteEnv();
  const connectedModeEnabled = isConnectedModeEnabled(env);
  const rawUrl = readStringEnv(env, 'VITE_SUPABASE_URL');
  const rawKey = readStringEnv(env, 'VITE_SUPABASE_PUBLISHABLE_KEY');

  const urlCheck = parseSafeSupabaseUrl(rawUrl);
  const forbiddenSecret = isForbiddenSecretKey(rawKey);
  const hasPublishableKey = rawKey.length > 0 && !forbiddenSecret;

  let errorCode: SupabaseConfigErrorCode | null = null;
  let errorMessage: string | null = null;

  if (!connectedModeEnabled) {
    errorCode = 'CONNECTED_MODE_DISABLED';
    errorMessage = 'Connected Supabase mode is disabled (Demo Mode active).';
  } else if (!rawUrl) {
    errorCode = 'MISSING_SUPABASE_URL';
    errorMessage = 'VITE_SUPABASE_URL is required when Connected Mode is enabled.';
  } else if (!urlCheck.valid) {
    errorCode = 'INVALID_SUPABASE_URL';
    errorMessage = 'VITE_SUPABASE_URL must be a valid HTTPS (or local localhost) URL.';
  } else if (forbiddenSecret) {
    errorCode = 'FORBIDDEN_SECRET_KEY';
    errorMessage =
      'Blocked secret/service_role key in browser config. Use only VITE_SUPABASE_PUBLISHABLE_KEY.';
  } else if (!rawKey) {
    errorCode = 'MISSING_PUBLISHABLE_KEY';
    errorMessage = 'VITE_SUPABASE_PUBLISHABLE_KEY is required when Connected Mode is enabled.';
  }

  return {
    connectedModeEnabled,
    isConfigured: connectedModeEnabled && urlCheck.valid && hasPublishableKey,
    hasUrl: urlCheck.valid,
    hasPublishableKey,
    urlHost: urlCheck.host,
    errorCode,
    errorMessage,
  };
}

let cachedClient: SupabaseClient | null = null;
let cachedUrl: string | null = null;
let cachedKey: string | null = null;

/**
 * Lazily instantiates the browser-safe Supabase client ONLY when Connected Mode
 * is explicitly enabled and publishable configuration passes security checks.
 * Never activates network requests in Demo Mode (`VITE_ENABLE_SUPABASE_CRM !== "true"`).
 */
export function getSupabaseClient(
  envOverride?: EnvRecord,
  options?: { useCache?: boolean }
): SupabaseClient {
  const env = envOverride ?? readViteEnv();
  const status = getSupabaseConfigStatus(env);

  if (!status.isConfigured) {
    throw new Error(status.errorMessage ?? 'Supabase client is not configured.');
  }

  const url = readStringEnv(env, 'VITE_SUPABASE_URL');
  const key = readStringEnv(env, 'VITE_SUPABASE_PUBLISHABLE_KEY');
  const shouldCache = options?.useCache ?? !envOverride;

  if (shouldCache && cachedClient && cachedUrl === url && cachedKey === key) {
    return cachedClient;
  }

  const client = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Closed invite-only pharmacist CRM does not accept URL-hash OAuth/magic-link callbacks
      detectSessionInUrl: false,
    },
  });

  if (shouldCache) {
    cachedClient = client;
    cachedUrl = url;
    cachedKey = key;
  }
  return client;
}

export function resetSupabaseClientForTests(): void {
  cachedClient = null;
  cachedUrl = null;
  cachedKey = null;
}
