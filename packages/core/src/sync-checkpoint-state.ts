/** Shared requester checkpoint state machine used by memory and SQLite stores. */
export const DEFAULT_SYNC_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

export type DurableManifestDigest = `sha256:${string}`;
export type DurableManifestPrefixDigest = `sha256:${string}`;

export interface SyncCheckpointEntry {
  /** Verified manifest coordinate. Never use this value as a raw wire cursor. */
  offset: number;
  updatedAtMs: number;
  expiresAtMs: number;
  /** Full manifest verification and atomic materialization completed at this offset. */
  terminal?: boolean;
  /** Canonical META generation that gives this DATA offset/session meaning. */
  manifestDigest?: DurableManifestDigest;
  /** Canonical descriptor prefix already verified through `offset`. */
  manifestPrefixDigest?: DurableManifestPrefixDigest;
  /** Opaque responder snapshot token paired with the raw row coordinate below. */
  responderSessionId?: string;
  responderSessionExpiresAtMs?: number;
  /** Raw responder row coordinate for `responderSessionId`. */
  responderSessionOffset?: number;
}

export const SYNC_CHECKPOINT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function assertOffset(key: string, value: number, label = 'checkpoint offset'): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid sync ${label} for ${key}: ${value}`);
  }
}

function assertDigest(
  key: string,
  value: DurableManifestDigest | DurableManifestPrefixDigest | undefined,
  label: string,
): void {
  if (value !== undefined && !SYNC_CHECKPOINT_DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid sync ${label} for ${key}`);
  }
}

function hasFreshResponderSession(
  entry: SyncCheckpointEntry | undefined,
  nowMs: number,
): entry is SyncCheckpointEntry & Required<Pick<
SyncCheckpointEntry,
'responderSessionId' | 'responderSessionExpiresAtMs'
>> {
  return Boolean(entry?.responderSessionId)
    && Number.isSafeInteger(entry?.responderSessionExpiresAtMs)
    && (entry?.responderSessionExpiresAtMs ?? 0) > nowMs;
}

/** Fail-closed validation for records loaded from an untrusted persistence row. */
export function isValidSyncCheckpointEntry(entry: SyncCheckpointEntry): boolean {
  if (
    !Number.isSafeInteger(entry.offset)
    || entry.offset < 0
    || !Number.isSafeInteger(entry.updatedAtMs)
    || entry.updatedAtMs < 0
    || !Number.isSafeInteger(entry.expiresAtMs)
    || entry.expiresAtMs < entry.updatedAtMs
  ) return false;
  if (
    entry.manifestDigest !== undefined
    && !SYNC_CHECKPOINT_DIGEST_PATTERN.test(entry.manifestDigest)
  ) return false;
  if (
    entry.manifestPrefixDigest !== undefined
    && (
      entry.manifestDigest === undefined
      || !SYNC_CHECKPOINT_DIGEST_PATTERN.test(entry.manifestPrefixDigest)
    )
  ) return false;
  if (
    entry.terminal === true
    && (entry.manifestDigest === undefined || entry.manifestPrefixDigest === undefined)
  ) return false;

  const hasSessionField = entry.responderSessionId !== undefined
    || entry.responderSessionExpiresAtMs !== undefined
    || entry.responderSessionOffset !== undefined;
  if (!hasSessionField) return true;
  return Boolean(entry.responderSessionId)
    && Number.isSafeInteger(entry.responderSessionExpiresAtMs)
    && (entry.responderSessionExpiresAtMs ?? -1) >= 0
    && Number.isSafeInteger(entry.responderSessionOffset)
    && (entry.responderSessionOffset ?? -1) >= 0;
}

export function withoutSyncCheckpointResponderSession(
  existing: SyncCheckpointEntry,
): SyncCheckpointEntry {
  return {
    offset: existing.offset,
    updatedAtMs: existing.updatedAtMs,
    expiresAtMs: existing.expiresAtMs,
    ...(existing.terminal ? { terminal: true } : {}),
    ...(existing.manifestDigest ? { manifestDigest: existing.manifestDigest } : {}),
    ...(existing.manifestPrefixDigest
      ? { manifestPrefixDigest: existing.manifestPrefixDigest }
      : {}),
  };
}

export function transitionSyncCheckpointOffset(params: {
  key: string;
  existing?: SyncCheckpointEntry;
  value: number;
  nowMs: number;
  ttlMs: number;
  responderSessionOffset?: number;
}): SyncCheckpointEntry {
  const { key, existing, value, nowMs, ttlMs, responderSessionOffset } = params;
  assertOffset(key, value);
  if (responderSessionOffset !== undefined) {
    assertOffset(key, responderSessionOffset, 'responder session offset');
  }
  const preserveSession = existing?.manifestDigest === undefined
    && hasFreshResponderSession(existing, nowMs);
  const rawOffset = responderSessionOffset ?? value;
  return {
    offset: value,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    ...(preserveSession
      ? {
          responderSessionId: existing.responderSessionId,
          responderSessionExpiresAtMs: existing.responderSessionExpiresAtMs,
          responderSessionOffset: rawOffset,
        }
      : {}),
  };
}

export function transitionSyncCheckpointManifestOffset(params: {
  key: string;
  existing?: SyncCheckpointEntry;
  value: number;
  manifestDigest: DurableManifestDigest;
  nowMs: number;
  ttlMs: number;
  manifestPrefixDigest?: DurableManifestPrefixDigest;
  terminal?: boolean;
  responderSessionOffset?: number;
}): SyncCheckpointEntry {
  const {
    key,
    existing,
    value,
    manifestDigest,
    nowMs,
    ttlMs,
    manifestPrefixDigest,
    terminal = false,
    responderSessionOffset,
  } = params;
  assertOffset(key, value);
  assertDigest(key, manifestDigest, 'manifest digest');
  assertDigest(key, manifestPrefixDigest, 'manifest prefix digest');
  if (responderSessionOffset !== undefined) {
    assertOffset(key, responderSessionOffset, 'responder session offset');
  }
  if (terminal && manifestPrefixDigest === undefined) {
    throw new Error(`Invalid terminal sync checkpoint for ${key}: missing manifest prefix digest`);
  }
  const preserveSession = existing?.manifestDigest === manifestDigest
    && hasFreshResponderSession(existing, nowMs);
  const rawOffset = responderSessionOffset
    ?? existing?.responderSessionOffset
    ?? value;
  return {
    offset: value,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    manifestDigest,
    ...(terminal ? { terminal: true } : {}),
    ...(manifestPrefixDigest ? { manifestPrefixDigest } : {}),
    ...(preserveSession
      ? {
          responderSessionId: existing.responderSessionId,
          responderSessionExpiresAtMs: existing.responderSessionExpiresAtMs,
          responderSessionOffset: rawOffset,
        }
      : {}),
  };
}

export function transitionSyncCheckpointResponderSession(params: {
  key: string;
  existing?: SyncCheckpointEntry;
  sessionId: string;
  expiresAtMs: number;
  nowMs: number;
  ttlMs: number;
  manifestDigest?: DurableManifestDigest;
  manifestPrefixDigest?: DurableManifestPrefixDigest;
  responderSessionOffset?: number;
}): SyncCheckpointEntry {
  const {
    key,
    existing,
    sessionId,
    expiresAtMs,
    nowMs,
    ttlMs,
    manifestDigest,
    manifestPrefixDigest,
    responderSessionOffset,
  } = params;
  if (!sessionId || !Number.isSafeInteger(expiresAtMs)) {
    throw new Error(`Invalid sync responder session for ${key}`);
  }
  assertDigest(key, manifestDigest, 'manifest digest');
  assertDigest(key, manifestPrefixDigest, 'manifest prefix digest');
  if (responderSessionOffset !== undefined) {
    assertOffset(key, responderSessionOffset, 'responder session offset');
  }
  const bindingMatches = existing?.manifestDigest === manifestDigest;
  const offset = bindingMatches ? existing?.offset ?? 0 : 0;
  const rawOffset = responderSessionOffset
    ?? (bindingMatches ? existing?.responderSessionOffset ?? offset : 0);
  return {
    offset,
    updatedAtMs: bindingMatches ? existing?.updatedAtMs ?? nowMs : nowMs,
    expiresAtMs: bindingMatches
      ? existing?.expiresAtMs ?? nowMs + ttlMs
      : nowMs + ttlMs,
    ...(manifestDigest ? { manifestDigest } : {}),
    ...(manifestPrefixDigest
      ? { manifestPrefixDigest }
      : bindingMatches && existing?.manifestPrefixDigest
        ? { manifestPrefixDigest: existing.manifestPrefixDigest }
        : {}),
    ...(bindingMatches && existing?.terminal ? { terminal: true } : {}),
    responderSessionId: sessionId,
    responderSessionExpiresAtMs: expiresAtMs,
    responderSessionOffset: rawOffset,
  };
}
