import { readAssertionPromoteEvidence } from './assertion-promote-evidence.js';
import {
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1, type AssertionSeal,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { PublisherAssertionPromoteOptions, AssertionPromoteResult } from './assertion-promote-types.js';
import { createShareOperationId, createPromoteOperationIntent, parsePromoteOperationIntent,
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

export function validatePromoteRecoveryBinding(value: unknown): PromoteRecoveryBinding {
  const candidate = value as Partial<PromoteRecoveryBinding> | undefined;
  if (candidate?.version !== 1 || typeof candidate.sealDigest !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(candidate.sealDigest)
    || typeof candidate.inventoryRequired !== 'boolean'
    || typeof candidate.intent?.operationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(candidate.intent.operationId)) {
    throw recoveryBindingConflict('Missing or invalid immutable share recovery binding');
  }
  const intent = parsePromoteOperationIntent(JSON.stringify(candidate.intent), candidate.intent.operationId);
  return Object.freeze({ version: 1, sealDigest: candidate.sealDigest, intent,
    inventoryRequired: candidate.inventoryRequired });
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
  verifyCompleted?: (seal: AssertionSeal, operationId?: string) => Promise<AssertionPromoteResult | null>,
): Promise<PromoteRecoveryAdmission> {
  const evidence = await readPromoteRecoveryEvidence(store, contextGraphId, name, agentAddress, opts);
  const { seal, sealDigest } = evidence;
  const layer = evidence.readLayer();
  const operation = evidence.readOperation();
  if ((operation.kind === 'legacy' || (operation.kind === 'absent' && layer === 'VM')) && verifyCompleted) {
    const completedResult = await verifyCompleted(seal, operation.kind === 'legacy' ? operation.operationId : undefined);
    if (completedResult) return { completedResult };
  }
  if (operation.kind === 'legacy') throw recoveryBindingConflict('The existing share operation lacks a complete immutable intent');
  const intent = operation.kind === 'complete' ? operation.intent
    : createPromoteOperationIntent({ operationId: createShareOperationId(), timestampMs: Date.now(),
      publisherPeerId: opts?.publisherPeerId, confirmationRequired: opts?.confirmBeforeCommit !== undefined,
      accessPolicy: opts?.accessPolicy ?? (seal.privateTripleCount ? 'ownerOnly' : 'public'), allowedPeers: opts?.allowedPeers });
  return validatePromoteRecoveryBinding({ version: 1, intent, inventoryRequired, sealDigest });
}

/** Recheck immutable stored evidence before entering any replay mutation. */
export async function assertPromoteRecoveryBinding(
  store: TripleStore, contextGraphId: string, name: string, agentAddress: string,
  opts: PublisherAssertionPromoteOptions,
) {
  const binding = validatePromoteRecoveryBinding(opts.recoveryBinding);
  const current = await readPromoteRecoveryEvidence(store, contextGraphId, name, agentAddress, opts);
  if (current.sealDigest !== binding.sealDigest) throw recoveryBindingConflict('The sealed asset changed after durable share admission');
  const operation = current.readOperation();
  if (operation.kind === 'legacy') throw recoveryBindingConflict('The original share operation lost its immutable intent');
  if (operation.kind === 'complete'
    && serializePromoteOperationIntent(operation.intent) !== serializePromoteOperationIntent(binding.intent)) {
    throw recoveryBindingConflict('The immutable share operation changed after durable admission');
  }
  return current;
}
