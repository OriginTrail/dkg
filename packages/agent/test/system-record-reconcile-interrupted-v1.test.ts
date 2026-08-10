import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeSystemRecordStableKeyHashV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

const traversalAdvance = vi.hoisted(() => vi.fn());

vi.mock('@origintrail-official/dkg-core/system-record-inventory-row-traversal-v1', () => ({
  createSystemRecordInventoryRowTraversalV1: () => Object.freeze({
    advance: traversalAdvance,
  }),
}));

import { createAgentProfileReconcilerV1 } from '../src/system-records/reconcile-v1.js';
import {
  admissionGate,
  NETWORK,
  publishedFixture,
  receiverWithPreparation,
} from './support/system-record-reconcile-v1-fixture.js';

describe('agent-profile System Record interrupted inventory retention', () => {
  beforeEach(() => {
    traversalAdvance.mockReset();
  });

  it.each([
    { reason: 'aborted' as const, abortCaller: true },
    { reason: 'deadline' as const, abortCaller: false },
  ])('applies rows returned by a $reason traversal slice without advancing inventory again', async ({
    reason,
    abortCaller,
  }) => {
    const fixture = await publishedFixture();
    const headEnvelope = fixture.store.snapshot().currentHead;
    if (headEnvelope === null) throw new Error('fixture active head was not retained');
    const row: SystemRecordInventoryRowV1 = Object.freeze({
      stableKeyHash: computeSystemRecordStableKeyHashV1(NETWORK, fixture.peerSigner.peerId),
      peerId: fixture.peerSigner.peerId,
      authoritySequence: headEnvelope.object.authoritySequence,
      version: headEnvelope.object.version,
      headDigest: headEnvelope.objectDigest,
      tombstone: false,
      quarantined: false,
    });
    const caller = new AbortController();
    const interruption = new Error(`${reason} after a validated leaf`);
    traversalAdvance.mockImplementationOnce(async () => {
      if (abortCaller) caller.abort(interruption);
      return Object.freeze({
        status: 'failed' as const,
        requests: 1,
        wireBytes: 512,
        progress: Object.freeze({
          totalValidatedRows: 1,
          totalValidatedLeaves: 1,
        }),
        sliceRows: Object.freeze([row]),
        failure: Object.freeze({
          reason,
          message: interruption.message,
        }),
      });
    });
    const apply = vi.fn(async () => Object.freeze({
      outcome: 'applied' as const,
      stateRevision: '1',
      appliedStateDigest: `0x${'aa'.repeat(32)}` as const,
    }));
    const prepareActive = vi.fn(async () => Object.freeze({ apply }));
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject: vi.fn(fixture.loadInventoryObject),
      receiver: receiverWithPreparation(prepareActive),
    });

    const interruptedAdvance = reconciler.advance(caller.signal);
    if (abortCaller) await expect(interruptedAdvance).rejects.toBe(interruption);
    else {
      await expect(interruptedAdvance).resolves.toMatchObject({
        status: 'paused',
        phase: 'records',
        pendingRows: 1,
      });
    }
    expect(reconciler.stats()).toMatchObject({
      inventoryRequests: 1,
      inventoryWireBytes: 512,
      pendingRows: 1,
      processedRows: 0,
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'inventory',
      processedRows: 1,
      pendingRows: 0,
      outcomes: [{ outcome: 'applied' }],
    });
    expect(traversalAdvance).toHaveBeenCalledTimes(1);
    expect(prepareActive).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
