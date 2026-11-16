import { computeDispensingPayloadHash, sha256HexSync } from './clinicalSafety';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PendingTokenEntry {
  clientEventUuid: string;
  createdAtMs: number;
}

const STORAGE_KEY = 'masar_care_pending_dispense_tokens_v1';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const memoryFallbackStore = new Map<string, PendingTokenEntry>();

function resolveStorage(override?: StorageLike): StorageLike | null {
  if (override) return override;
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // Ignore restricted storage environments (e.g. sandboxed iframe / SSR)
  }
  return null;
}

function defaultUuidGenerator(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function readTokenMap(storage: StorageLike | null, nowMs: number): Record<string, PendingTokenEntry> {
  const result: Record<string, PendingTokenEntry> = {};
  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
          for (const [k, val] of Object.entries(parsed)) {
            if (
              val &&
              typeof val === 'object' &&
              typeof (val as PendingTokenEntry).clientEventUuid === 'string' &&
              typeof (val as PendingTokenEntry).createdAtMs === 'number' &&
              nowMs - (val as PendingTokenEntry).createdAtMs <= TOKEN_TTL_MS
            ) {
              result[k] = val as PendingTokenEntry;
            }
          }
        }
      }
    } catch {
      // Corrupt or unreadable storage degrades gracefully to fresh map
    }
  } else {
    for (const [k, val] of memoryFallbackStore.entries()) {
      if (nowMs - val.createdAtMs <= TOKEN_TTL_MS) {
        result[k] = val;
      } else {
        memoryFallbackStore.delete(k);
      }
    }
  }
  return result;
}

function writeTokenMap(
  storage: StorageLike | null,
  map: Record<string, PendingTokenEntry>
): void {
  if (storage) {
    try {
      const keys = Object.keys(map);
      if (keys.length === 0) {
        storage.removeItem(STORAGE_KEY);
      } else {
        storage.setItem(STORAGE_KEY, JSON.stringify(map));
      }
    } catch {
      // Ignore quota / security errors
    }
  } else {
    memoryFallbackStore.clear();
    for (const [k, val] of Object.entries(map)) {
      memoryFallbackStore.set(k, val);
    }
  }
}

/**
 * Computes an opaque, non-PHI correlation digest from the active pharmacy, user,
 * and canonical dispensing payload hash. Zero patient names, IDs, medications, or dates are stored.
 */
export function buildDispensingIdempotencyScopeKey(
  pharmacyId: string,
  paramsOrUserId: Parameters<typeof computeDispensingPayloadHash>[0] | string,
  maybeParams?: Parameters<typeof computeDispensingPayloadHash>[0]
): string {
  const userId = typeof paramsOrUserId === 'string' ? paramsOrUserId.trim() : '';
  const params = typeof paramsOrUserId === 'string' ? maybeParams! : paramsOrUserId;
  const payloadHash = computeDispensingPayloadHash(params);
  return sha256HexSync(`${pharmacyId.trim()}|${userId}|${payloadHash}`);
}

export function peekPendingDispensingUuid(
  scopeKey: string,
  storageOverride?: StorageLike,
  nowMs: number = Date.now()
): string | null {
  if (!scopeKey) return null;
  const storage = resolveStorage(storageOverride);
  const map = readTokenMap(storage, nowMs);
  return map[scopeKey]?.clientEventUuid ?? null;
}

export function getPendingDispensingUuids(
  storageOverride?: StorageLike,
  nowMs: number = Date.now()
): Set<string> {
  const storage = resolveStorage(storageOverride);
  const map = readTokenMap(storage, nowMs);
  return new Set(Object.values(map).map((entry) => entry.clientEventUuid));
}

export function getOrCreatePendingDispensingUuid(
  scopeKey: string,
  uuidFactory: () => string = defaultUuidGenerator,
  storageOverride?: StorageLike,
  nowMs: number = Date.now()
): string {
  if (!scopeKey) {
    return uuidFactory();
  }
  const storage = resolveStorage(storageOverride);
  const map = readTokenMap(storage, nowMs);
  const existing = map[scopeKey];
  if (existing) {
    return existing.clientEventUuid;
  }
  const createdUuid = uuidFactory();
  map[scopeKey] = {
    clientEventUuid: createdUuid,
    createdAtMs: nowMs,
  };
  writeTokenMap(storage, map);
  return createdUuid;
}

export function clearPendingDispensingUuid(
  scopeKey: string,
  storageOverride?: StorageLike,
  nowMs: number = Date.now()
): void {
  if (!scopeKey) return;
  const storage = resolveStorage(storageOverride);
  const map = readTokenMap(storage, nowMs);
  if (scopeKey in map) {
    delete map[scopeKey];
    writeTokenMap(storage, map);
  }
}

export function clearAllPendingDispensingUuids(storageOverride?: StorageLike): void {
  const storage = resolveStorage(storageOverride);
  if (storage) {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore storage removal errors
    }
  }
  memoryFallbackStore.clear();
}
