import { ethers } from 'ethers';
import { isStoreOperationTimeoutError, isStoreSchedulerBusyError, isStoreReadTransportFailure,
  StoreOperationTimeoutError, StoreSchedulerBusyError, type Quad } from '@origintrail-official/dkg-storage';
import type { ResolvedAssertionSource } from './assertion-seal-recovery.js';
import { validateGraphScopedPayloadAgainstSeal } from './assertion-seal-recovery.js';

export interface ExactPullSource {
  kaUal: string;
  assertionVersion: string;
  merkleRoot: string;
}

export interface AssertionPullFromOptions {
  subGraphName?: string;
  onConflict?: 'reject' | 'replace';
  /** Verify an existing draft without writes. Retain this tuple before the original pull. */
  recoverExact?: ExactPullSource;
}

export interface AssertionDraftEvidence extends ExactPullSource {
  contextGraphId: string;
  subGraphName?: string;
  name: string;
  agentAddress: string;
  fromLayer: 'swm' | 'vm';
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot: string | null;
}

export interface AssertionPullFromResult extends ExactPullSource {
  seeded: number;
  seededPublic: number;
  seededPrivate: number;
  fromLayer: 'swm' | 'vm';
  contentScopeVersion: number;
  recovered?: true;
  draftEvidence?: AssertionDraftEvidence;
}

/** Parse untrusted transport input and copy the pin before any asynchronous work. */
export function parseExactPullSource(value: unknown, onConflict: unknown = 'reject'): ExactPullSource | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const pin = value as Record<string, unknown>;
    if (typeof pin.kaUal === 'string' && pin.kaUal
      && typeof pin.assertionVersion === 'string' && /^[1-9]\d*$/.test(pin.assertionVersion)
      && typeof pin.merkleRoot === 'string' && /^0x[0-9a-fA-F]{64}$/.test(pin.merkleRoot)
      && (onConflict === undefined || onConflict === 'reject')) {
      return { kaUal: pin.kaUal, assertionVersion: pin.assertionVersion, merkleRoot: pin.merkleRoot.toLowerCase() };
    }
  }
  throw Object.assign(new Error('recoverExact requires kaUal, assertionVersion and merkleRoot strings and onConflict:"reject".'),
    { code: 'INVALID_PULL_RECOVERY_OPTIONS' });
}

export function snapshotAssertionPullOptions(opts?: AssertionPullFromOptions): AssertionPullFromOptions | undefined {
  return opts ? { ...opts, recoverExact: parseExactPullSource(opts.recoverExact, opts.onConflict) } : undefined;
}

/** Preserve retry classification without propagating store excerpts or exception causes. */
export function rethrowDraftSourceFailure(error: unknown): never {
  if (isStoreOperationTimeoutError(error)) throw new StoreOperationTimeoutError({
    backend: 'triple-store', operation: 'query', timeoutMs: error.timeoutMs, outcome: 'not_started',
  });
  if (isStoreSchedulerBusyError(error)) throw new StoreSchedulerBusyError(error.reason, error.priority, 'query', { storeOperation: 'query' });
  if (isStoreReadTransportFailure(error)) throw Object.assign(
    new Error('Draft recovery could not read the store; retry verification. No draft was modified.'),
    { code: 'WM_RECOVERY_UNAVAILABLE', retryable: true });
  throw draftRecoveryError('WM_RECOVERY_SOURCE_UNAVAILABLE');
}

/** Bounded errors deliberately exclude RDF, parser errors and exception causes. */
export function draftRecoveryError(code: 'WM_DRAFT_NOT_EXACT' | 'WM_RECOVERY_SOURCE_UNAVAILABLE'): Error {
  return Object.assign(new Error(code === 'WM_DRAFT_NOT_EXACT'
    ? 'The existing WM draft is not the exact pinned source; no draft was modified.'
    : 'The pinned recovery source is unavailable or superseded; no draft was modified.'), { code });
}

/** Caller holds the assertion lifecycle lock across source selection and BOTH partition reads. */
export async function verifyExactAssertionDraft(input: {
  source: ResolvedAssertionSource;
  contextGraphId: string;
  subGraphName?: string;
  name: string;
  agentAddress: string;
  fromLayer: 'swm' | 'vm';
  publicQuads: Quad[];
  privateQuads: Quad[];
}): Promise<AssertionDraftEvidence> {
  const { source, publicQuads, privateQuads, ...binding } = input;
  try {
    await validateGraphScopedPayloadAgainstSeal(source.loadedSeal.seal, publicQuads, privateQuads, 'wm-draft');
  } catch { throw draftRecoveryError('WM_DRAFT_NOT_EXACT'); }
  const seal = source.loadedSeal.seal;
  return { ...binding, kaUal: source.scope.ual, assertionVersion: source.scope.assertionVersion,
    publicTripleCount: publicQuads.length, privateTripleCount: privateQuads.length,
    merkleRoot: ethers.hexlify(seal.merkleRoot),
    privateMerkleRoot: seal.privateMerkleRoot ? ethers.hexlify(seal.privateMerkleRoot) : null };
}
