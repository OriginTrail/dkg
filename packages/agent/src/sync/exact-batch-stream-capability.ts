import type { ContextGraphBinding } from '../context-graph-binding-state.js';

/** Connection-bound transport hint only: never membership or absence evidence. */
const unsupportedByOwner = new WeakMap<object, Map<string, {
  readonly connectionKey: string;
  readonly expiresAt: number;
}>>();

export const EXACT_BATCH_UNSUPPORTED_TTL_MS = 60_000;
export const EXACT_BATCH_UNSUPPORTED_MAX_PEERS = 128;

/** Resource refusal is a transport hint for one captured graph binding only. */
const resourceRefusedByOwner = new WeakMap<object, Map<string, {
  readonly peerId: string;
  readonly bindingKey: string;
  readonly connectionKey: string;
  readonly expiresAt: number;
}>>();
// Keep this beyond the ordinary one-minute recovery cadence and its jitter.
// The optional profile may be retried after expiry; no read extends the hint.
export const EXACT_BATCH_RESOURCE_REFUSAL_TTL_MS = 10 * 60_000;
export const EXACT_BATCH_RESOURCE_REFUSAL_MAX_ENTRIES = 128;

export interface ExactBatchStreamRefusalScope {
  readonly contextGraphId: string;
  readonly bindingKey: string;
}

/** Memory-only fence; no authority read and no membership or absence credit. */
export function captureExactBatchStreamRefusalScope(params: {
  readonly contextGraphId: string;
  readonly deploymentId: string;
  readonly binding: ContextGraphBinding | undefined;
  readonly bindingGeneration: number;
  readonly selectedBindingGeneration?: number;
  readonly lifecycleGeneration: number;
}): ExactBatchStreamRefusalScope | null {
  const { binding } = params;
  if (!binding || typeof params.deploymentId !== 'string' || !params.deploymentId) return null;
  return Object.freeze({ contextGraphId: params.contextGraphId, bindingKey: JSON.stringify([params.deploymentId, binding.bindingKind, binding.onChainId,
    binding.bindingKind === 'reverse-name-hash' ? binding.nameHash : null,
    params.bindingGeneration, params.selectedBindingGeneration ?? null, params.lifecycleGeneration]) });
}

/** Call only for a validated RESOURCE_LIMIT after physical stream settlement. */
export function rememberExactBatchStreamResourceRefusal(
  owner: object,
  peerId: string,
  admittedConnectionKey: string | null,
  currentConnectionKey: string | null,
  admittedScope: ExactBatchStreamRefusalScope | null,
  currentScope: ExactBatchStreamRefusalScope | null,
  now: number,
): void {
  if (!peerId || admittedConnectionKey === null || admittedConnectionKey !== currentConnectionKey
    || admittedScope === null || currentScope === null
    || admittedScope.contextGraphId !== currentScope.contextGraphId || admittedScope.bindingKey !== currentScope.bindingKey
    || !Number.isFinite(now)) return;
  let entries = resourceRefusedByOwner.get(owner);
  if (!entries) { entries = new Map(); resourceRefusedByOwner.set(owner, entries); }
  const key = JSON.stringify([peerId, admittedScope.contextGraphId]);
  entries.delete(key);
  entries.set(key, { peerId, bindingKey: admittedScope.bindingKey, connectionKey: admittedConnectionKey, expiresAt: now + EXACT_BATCH_RESOURCE_REFUSAL_TTL_MS });
  while (entries.size > EXACT_BATCH_RESOURCE_REFUSAL_MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

function resourceRefused(owner: object, peerId: string, connectionKey: string | null,
  scope: ExactBatchStreamRefusalScope | null | undefined, now: number): boolean {
  const entries = resourceRefusedByOwner.get(owner);
  if (!entries) return false;
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now || (entry.peerId === peerId && entry.connectionKey !== connectionKey)) entries.delete(key);
  }
  if (scope == null) return false;
  const key = JSON.stringify([peerId, scope.contextGraphId]);
  const entry = entries.get(key);
  if (!entry) return false;
  if (entry.bindingKey !== scope.bindingKey) { entries.delete(key); return false; }
  entries.delete(key);
  entries.set(key, entry);
  return true;
}

export function exactBatchStreamUnsupported(
  owner: object,
  peerId: string,
  connectionKey: string | null,
  now: number,
  resourceScope?: ExactBatchStreamRefusalScope | null,
): boolean {
  const entries = unsupportedByOwner.get(owner);
  const entry = entries?.get(peerId);
  if (!entry) return resourceRefused(owner, peerId, connectionKey, resourceScope, now);
  if (connectionKey === null || entry.connectionKey !== connectionKey || entry.expiresAt <= now) {
    entries!.delete(peerId);
    return resourceRefused(owner, peerId, connectionKey, resourceScope, now);
  }
  entries!.delete(peerId);
  entries!.set(peerId, entry);
  return true;
}

/** Call only for Core's typed unsupported-before-START negotiation failure. */
export function rememberExactBatchStreamUnsupported(
  owner: object,
  peerId: string,
  admittedConnectionKey: string | null,
  currentConnectionKey: string | null,
  now: number,
): void {
  if (!peerId || admittedConnectionKey === null || admittedConnectionKey !== currentConnectionKey
    || !Number.isFinite(now)) return;
  let entries = unsupportedByOwner.get(owner);
  if (!entries) { entries = new Map(); unsupportedByOwner.set(owner, entries); }
  entries.delete(peerId);
  entries.set(peerId, { connectionKey: admittedConnectionKey, expiresAt: now + EXACT_BATCH_UNSUPPORTED_TTL_MS });
  while (entries.size > EXACT_BATCH_UNSUPPORTED_MAX_PEERS) entries.delete(entries.keys().next().value!);
}
