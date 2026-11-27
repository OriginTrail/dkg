import { describe, expect, it } from 'vitest';
import { RemoteSignerError } from '@origintrail-official/dkg-chain';
import { createPromotePostCommitFailure, createPromoteRetryableFailure } from '@origintrail-official/dkg-publisher';
import { Rfc64ControlEnvelopeSigningErrorV1 } from '../src/rfc64/control-envelope-signer-v1.js';
import { Rfc64SwmAuthorInventoryProducerErrorV1 } from '../src/rfc64/swm-author-inventory-producer-v1.js';
import { SwmCatalogAuthorityNotReady, SwmInventoryWriteFailure } from '../src/internal/swm-inventory-write.js';
import { ConfirmedVmOwnershipFailure } from '../src/internal/confirmed-vm-catalog-observer.js';
import {
  attachCommittedShare, committedSharePendingCatalogHandoff, committedSharePendingReason,
  inventoryHandoffPendingFailure, inventoryHandoffPendingReason, throwConfirmedOwnershipFailure, throwInventoryRecoveryFailure,
} from '../src/internal/promote/inventory-recovery-failure.js';
import { committedSharePendingCatalogHandoff as exportedReader } from '../src/index.js';

const HANDOFF = Symbol.for('dkg.agent.committedSharePendingCatalogHandoff.v1');
const committed = { promotedCount: 1, sealed: true, publishReady: true, shareOperationId: 'original-operation' } as const;

function transientSignerFailure(): Error {
  return createPromoteRetryableFailure(new Rfc64SwmAuthorInventoryProducerErrorV1('swm-inventory-producer-signer', 'signing failed', {
    cause: new Rfc64ControlEnvelopeSigningErrorV1('callback', 'callback failed', { cause: new RemoteSignerError('REMOTE_SIGNER_TIMEOUT', 'fixture') }),
  }));
}

describe('committed share on a pending catalog handoff', () => {
  it.each([
    ['inactive-lane', () => inventoryHandoffPendingFailure('inactive-lane', 'Durable share inventory remains pending: inactive-lane')],
    ['authority-transition', () => inventoryHandoffPendingFailure('authority-transition', 'Durable share inventory remains pending: authority-transition')],
    ['projection-admission', () => inventoryHandoffPendingFailure('projection-admission', 'Durable share catalog projection admission remains pending')],
    ['authority-not-ready', () => createPromoteRetryableFailure(new SwmCatalogAuthorityNotReady('service-unavailable'))],
  ] as const)('carries a committed share on a pending %s handoff failure without changing it', (reason, make) => {
    const error = make() as Error & { code?: string };
    const before = { json: JSON.stringify(error), keys: Object.keys(error), message: error.message, code: error.code, cause: error.cause };
    expect(committedSharePendingReason(error)).toBe(reason);
    expect(attachCommittedShare(error, committed)).toBe(error);
    expect(committedSharePendingCatalogHandoff(error)).toEqual({ reason, result: committed });
    expect(exportedReader(error)).toEqual({ reason, result: committed });
    expect(JSON.stringify(error)).toBe(before.json);
    expect(Object.keys(error)).toEqual(before.keys);
    expect({ message: error.message, code: error.code, cause: error.cause })
      .toEqual({ message: before.message, code: before.code, cause: before.cause });
    expect(error.cause).toBe(before.cause);
    const descriptor = Object.getOwnPropertyDescriptor(error, HANDOFF)!;
    expect(descriptor).toMatchObject({ writable: false, enumerable: false, configurable: false });
    expect(Object.isFrozen(descriptor.value)).toBe(true);
    expect(Object.isFrozen(descriptor.value.result)).toBe(true);
    // The first committed result stays; a later attach cannot replace it.
    expect(attachCommittedShare(error, { ...committed, promotedCount: 2 })).toBe(error);
    expect(committedSharePendingCatalogHandoff(error)?.result.promotedCount).toBe(1);
  });

  it.each([
    ['confirmed-ownership', () => inventoryHandoffPendingFailure('confirmed-ownership', 'Confirmed share catalog ownership remains pending')],
    ['a transient signer failure', transientSignerFailure],
    ['a post-commit failure', () => createPromotePostCommitFailure(new Error('pointer write interrupted'))],
    ['an untyped failure', () => new Error('inventory unavailable')],
    ['a retryable failure with an untyped cause', () => createPromoteRetryableFailure(new Error('store busy'))],
  ] as const)('does not carry a committed share on %s', (_label, make) => {
    const error = make();
    expect(committedSharePendingReason(error)).toBeUndefined();
    expect(attachCommittedShare(error, committed)).toBe(error);
    expect(Object.getOwnPropertySymbols(error)).not.toContain(HANDOFF);
    expect(committedSharePendingCatalogHandoff(error)).toBeUndefined();
  });

  it('does not carry a committed share on a readiness failure of the confirmed VM ownership step', async () => {
    const notReady = new SwmCatalogAuthorityNotReady('service-unavailable');
    const failure = await throwConfirmedOwnershipFailure(new ConfirmedVmOwnershipFailure('authority', notReady)).catch(e => e);
    // The failure keeps its retryable identity and typed cause for the queue.
    expect(failure).toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
    expect(failure.cause).toBe(notReady);
    expect(committedSharePendingReason(failure)).toBeUndefined();
    expect(attachCommittedShare(failure, committed)).toBe(failure);
    expect(Object.getOwnPropertySymbols(failure)).not.toContain(HANDOFF);
    expect(committedSharePendingCatalogHandoff(failure)).toBeUndefined();
    // The same cause from the shared-memory inventory step still qualifies.
    const inventoryStep = await throwInventoryRecoveryFailure(new SwmInventoryWriteFailure('authority', null, notReady)).catch(e => e);
    expect(committedSharePendingReason(inventoryStep)).toBe('authority-not-ready');
    const refused = new Error('catalog policy authority invalid');
    await expect(throwConfirmedOwnershipFailure(new ConfirmedVmOwnershipFailure('authority', refused))).rejects.toBe(refused);
  });

  it('names the typed waiting step of a pending handoff only', () => {
    expect(inventoryHandoffPendingReason(inventoryHandoffPendingFailure('confirmed-ownership', 'pending'))).toBe('confirmed-ownership');
    expect(inventoryHandoffPendingReason(inventoryHandoffPendingFailure('inactive-lane', 'pending'))).toBe('inactive-lane');
    const unknownReason = createPromoteRetryableFailure(Object.assign(new Error('pending'), { code: 'SWM_INVENTORY_HANDOFF_PENDING', reason: 'other' }));
    expect(inventoryHandoffPendingReason(unknownReason)).toBeUndefined();
    const notRetryable = Object.assign(new Error('pending'), { code: 'SWM_INVENTORY_HANDOFF_PENDING', reason: 'inactive-lane' });
    expect(inventoryHandoffPendingReason(notRetryable)).toBeUndefined();
    for (const value of [undefined, null, 'PROMOTE_RETRYABLE_FAILURE', 7]) {
      expect(inventoryHandoffPendingReason(value)).toBeUndefined();
      expect(committedSharePendingCatalogHandoff(value)).toBeUndefined();
      expect(attachCommittedShare(value, committed)).toBe(value);
    }
  });

  it('leaves a frozen failure unchanged', () => {
    const error = Object.freeze(inventoryHandoffPendingFailure('inactive-lane', 'pending'));
    expect(attachCommittedShare(error, committed)).toBe(error);
    expect(committedSharePendingCatalogHandoff(error)).toBeUndefined();
  });

  it('ignores a value under the key whose reason or shape does not match the typed cause', () => {
    const mismatched = inventoryHandoffPendingFailure('confirmed-ownership', 'pending');
    Object.defineProperty(mismatched, HANDOFF, { value: { reason: 'inactive-lane', result: committed } });
    expect(committedSharePendingCatalogHandoff(mismatched)).toBeUndefined();
    const malformed = inventoryHandoffPendingFailure('inactive-lane', 'pending');
    Object.defineProperty(malformed, HANDOFF, { value: { reason: 'inactive-lane', result: { promotedCount: 1 } } });
    expect(committedSharePendingCatalogHandoff(malformed)).toBeUndefined();
  });
});
