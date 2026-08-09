import { describe, expect, it, vi } from 'vitest';

import { createAgentProfileReconcilerV1 } from '../src/system-records/reconcile-v1.js';
import {
  admissionGate,
  NETWORK,
  publishedFixture,
  receiver,
} from './support/system-record-reconcile-v1-fixture.js';

describe('agent-profile System Record reconciler inventory transport', () => {
  it('accounts exact wire for malformed and aborted inventory responses', async () => {
    const malformedFixture = await publishedFixture();
    let malformedWireBytes = 0;
    const malformed = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: malformedFixture.rootEnvelope,
      providerPeerPublicKey: malformedFixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject: async (request, signal) => {
        const loaded = await malformedFixture.loadInventoryObject(request, signal);
        if (loaded.outcome !== 'ok') return loaded;
        malformedWireBytes = loaded.wireBytes;
        return Object.freeze({
          ...loaded,
          canonicalBytes: Uint8Array.from([0, ...loaded.canonicalBytes.subarray(1)]),
        });
      },
      receiver: receiver(malformedFixture.store, vi.fn()),
    });

    const malformedResult = await malformed.advance(new AbortController().signal);
    expect(malformedResult).toMatchObject({
      status: 'blocked',
      reason: 'inventory-invalid-response',
      inventoryRequests: 1,
      inventoryWireBytes: malformedWireBytes,
    });
    expect(malformed.stats()).toMatchObject({
      inventoryRequests: 1,
      inventoryWireBytes: malformedWireBytes,
    });

    const abortedFixture = await publishedFixture();
    const caller = new AbortController();
    const rootRequest = Object.freeze({
      rootDescriptorDigest: abortedFixture.rootEnvelope.objectDigest,
      objectDigest: abortedFixture.rootEnvelope.object.treeRootDigest,
      expectedKind: 'inventory-leaf' as const,
      path: Object.freeze([] as number[]),
    });
    const loaded = await abortedFixture.loadInventoryObject(
      rootRequest,
      new AbortController().signal,
    );
    const requested = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<typeof loaded>();
    const aborted = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: abortedFixture.rootEnvelope,
      providerPeerPublicKey: abortedFixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject: () => {
        requested.resolve();
        return delivery.promise;
      },
      receiver: receiver(abortedFixture.store, vi.fn()),
    });

    const abortedAdvance = aborted.advance(caller.signal);
    await requested.promise;
    delivery.resolve(loaded);
    // Settle the response through the loader boundary before cancellation is observed.
    await Promise.resolve();
    await Promise.resolve();
    caller.abort(new Error('caller-aborted-after-response'));
    await expect(abortedAdvance).rejects.toThrow(/caller-aborted-after-response/);
    expect(aborted.stats()).toMatchObject({
      inventoryRequests: 1,
      inventoryWireBytes: loaded.wireBytes,
      active: 0,
    });
  });

  it('accepts and accounts a zero-byte transport reset', async () => {
    const fixture = await publishedFixture();
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject: async () => Object.freeze({
        outcome: 'rejected' as const,
        wireBytes: 0,
        rejection: 'transport' as const,
      }),
      receiver: receiver(fixture.store, vi.fn()),
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'inventory-transport',
      inventoryRequests: 1,
      inventoryWireBytes: 0,
    });
    expect(reconciler.stats()).toMatchObject({ inventoryRequests: 1, inventoryWireBytes: 0 });
  });

  it('maps a thrown inventory loader failure to a released transport block', async () => {
    const fixture = await publishedFixture();
    const admission = admissionGate();
    const sentinel = new Error('inventory transport socket closed');
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject: async () => { throw sentinel; },
      receiver: receiver(fixture.store, vi.fn()),
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'inventory',
      reason: 'inventory-transport',
      inventoryRequests: 1,
      inventoryWireBytes: 0,
      processedRows: 0,
      pendingRows: 0,
    });
    expect(admission.stats()).toEqual({ active: 0, peak: 1, acquisitions: 1 });
    expect(reconciler.stats()).toMatchObject({
      inventoryRequests: 1,
      inventoryWireBytes: 0,
      active: 0,
    });
  });
});
