import { readAssertionPromoteEvidence } from './assertion-promote-evidence.js';
import {
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1, type AssertionSeal,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { PublisherAssertionPromoteOptions, AssertionPromoteResult } from './assertion-promote-types.js';
import { createShareOperationId, createPromoteOperationIntent, validatePromoteOperationIntent, assertPromoteOperationIntent,
  serializePromoteOperationIntent, type PromoteOperationIntent } from './promote-operation-intent.js';

/** Immutable replay authority. This is produced internally, never accepted from HTTP. */
export interface PromoteRecoveryBinding {
  readonly version: 1;
  readonly sealDigest: string;
  readonly intent: PromoteOperationIntent;
  readonly inventoryRequired: boolean;
}

export function recoveryBindingConflict(message: string): Error {
  return Object.assign(new Error(message), { code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
}

/** A different valid operation won before this request acquired ownership. */
export class PromoteStaleAdmissionError extends Error {
  readonly code = 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT';
  constructor(readonly existingOperationId: string) {
    super('Another share operation completed admission before this prepared request');
    this.name = 'PromoteStaleAdmissionError';
  }
}

function assertBindingHeader(value: unknown): asserts value is Omit<PromoteRecoveryBinding, 'intent'> & { intent: { operationId: string } } {
  const candidate = value as Partial<PromoteRecoveryBinding> | undefined;
  if (candidate?.version !== 1 || typeof candidate.sealDigest !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(candidate.sealDigest)
    || typeof candidate.inventoryRequired !== 'boolean'
    || typeof candidate.intent?.operationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(candidate.intent.operationId)) {
    throw recoveryBindingConflict('Missing or invalid immutable share recovery binding');
  }
}

/** Predicates validate without constructing and discarding frozen snapshots. */
export function isPromoteRecoveryBinding(value: unknown): value is PromoteRecoveryBinding {
  try {
    assertBindingHeader(value);
    assertPromoteOperationIntent(value.intent, value.intent.operationId);
    return true;
  } catch { return false; }
}

export function validatePromoteRecoveryBinding(value: unknown): PromoteRecoveryBinding {
  assertBindingHeader(value);
  const intent = validatePromoteOperationIntent(value.intent, value.intent.operationId);
  return Object.freeze({ version: 1, sealDigest: value.sealDigest, intent,
    inventoryRequired: value.inventoryRequired });
}

export type PromoteRecoveryAdmission = PromoteRecoveryBinding | { completedResult: AssertionPromoteResult };
/** Read-only stored evidence; never constructs an admission or an operation ID. */
async function readPromoteRecoveryEvidence(
  store: TripleStore, contextGraphId: string, name: string, agentAddress: string,
  opts?: PublisherAssertionPromoteOptions,
) {
  const evidence = await readAssertionPromoteEvidence(store, contextGraphId, name, agentAddress, opts?.subGraphName);
  const seal = evidence.seal;
  if (!seal) throw recoveryBindingConflict('Durable sharing requires a complete finalized seal');
  return { ...evidence, seal,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(seal)) };
}

/** Called under the lifecycle lock; only admission may create a new intent. */
export async function preparePromoteRecoveryBinding(
  store: TripleStore, contextGraphId: string, name: string, agentAddress: string,
  opts: PublisherAssertionPromoteOptions | undefined, inventoryRequired: boolean,
  retireCompletion: () => Promise<void>,
  verifyCompleted?: (seal: AssertionSeal, operationId?: string) => Promise<AssertionPromoteResult | null>,
): Promise<PromoteRecoveryAdmission> {
  const evidence = await readPromoteRecoveryEvidence(store, contextGraphId, name, agentAddress, opts);
  const { seal, sealDigest } = evidence;
  const layer = evidence.readLayer();
  let operation: ReturnType<typeof evidence.readOperation>;
  try { operation = evidence.readOperation(); }
  catch (error) {
    // Refusing corrupt persisted authority must also revoke its publish certificate.
    await retireCompletion();
    throw error;
  }
  if ((operation.kind === 'legacy' || (operation.kind === 'absent' && layer === 'VM')) && verifyCompleted) {
    const completedResult = await verifyCompleted(seal, operation.kind === 'legacy' ? operation.operationId : undefined);
    if (completedResult) return { completedResult };
  }
  if (operation.kind === 'legacy') {
    await retireCompletion();
    throw recoveryBindingConflict('The existing share operation lacks a complete immutable intent');
  }
  const intent = operation.kind === 'complete' ? operation.intent
    : createPromoteOperationIntent({ operationId: createShareOperationId(), timestampMs: Date.now(),
      publisherPeerId: opts?.publisherPeerId, confirmationRequired: opts?.confirmBeforeCommit !== undefined,
      accessPolicy: opts?.accessPolicy ?? (seal.privateTripleCount ? 'ownerOnly' : 'public'), allowedPeers: opts?.allowedPeers });
  return validatePromoteRecoveryBinding({ version: 1, intent, inventoryRequired, sealDigest });
}

/** Recheck immutable stored evidence before entering any replay mutation. */
export async function assertPromoteRecoveryBinding(
  store: TripleStore, contextGraphId: string, name: string, agentAddress: string,
  opts: PublisherAssertionPromoteOptions, retireCompletion: () => Promise<void>, phase: 'admission' | 'replay',
) {
  const binding = validatePromoteRecoveryBinding(opts.recoveryBinding);
  const current = await readPromoteRecoveryEvidence(store, contextGraphId, name, agentAddress, opts);
  if (current.sealDigest !== binding.sealDigest) throw recoveryBindingConflict('The sealed asset changed after durable share admission');
  let operation: ReturnType<typeof current.readOperation>;
  try {
    operation = current.readOperation();
    if (operation.kind === 'legacy') throw recoveryBindingConflict('The original share operation lost its immutable intent');
  } catch (error) {
    // Only deterministic persisted-operation validation is inside this catch.
    // Reads and caller/seal validation above must not revoke a valid certificate.
    await retireCompletion();
    throw error;
  }
  if (operation.kind === 'complete'
    && serializePromoteOperationIntent(operation.intent) !== serializePromoteOperationIntent(binding.intent)) {
    // Another request can win between preparation and admission. Its valid
    // operation is not corrupt merely because this unadmitted binding is stale.
    if (phase === 'admission') throw new PromoteStaleAdmissionError(operation.intent.operationId);
    await retireCompletion();
    throw recoveryBindingConflict('The immutable share operation changed after durable admission');
  }
  return current;
}
