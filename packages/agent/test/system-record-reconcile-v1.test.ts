import { describe, expect, it, vi } from 'vitest';

import { decodeOpaqueKaBundleV1 } from '@origintrail-official/dkg-core';
import {
  buildSystemRecordProviderSignatureMessageV1,
  computeSystemRecordRootDescriptorDigestV1,
  parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { parseNQuads } from '../src/dkg-agent-utils.js';
import type { SystemRecordArtifactRepositoryV1 } from '../src/system-records/artifact-v1.js';
import { createAgentProfileReceiverV1 } from '../src/system-records/receiver-v1.js';
import {
  createAgentProfileReconcilerV1,
  type AgentProfileReconcileAdmissionV1,
  type AgentProfileInventoryLoadRequestV1,
} from '../src/system-records/reconcile-v1.js';
import {
  createFixtureAgentProfileProducerV1,
  NETWORK,
  produce,
  producerFixture,
  PRODUCER_FIXTURE_NOW_MS,
  DEPLOYMENT,
} from './support/agent-profile-producer-v1-fixture.js';

describe('agent-profile System Record reconciler V1', () => {
  it('pins one provider root and completes one active row across bounded slices', async () => {
    const fixture = await publishedFixture();
    const admission = admissionGate();
    const consumeCandidate = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '1',
      appliedStateDigest: `0x${'aa'.repeat(32)}`,
    }));
    const loadInventoryObject = vi.fn(fixture.loadInventoryObject);
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject,
      receiver: receiver(fixture.store, consumeCandidate),
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
    });

    const signal = new AbortController().signal;
    await expect(reconciler.advance(signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      inventoryRequests: 1,
      processedRows: 0,
      pendingRows: 1,
    });
    expect(loadInventoryObject).toHaveBeenCalledTimes(1);
    expect(loadInventoryObject.mock.calls[0]![0]).toMatchObject({
      rootDescriptorDigest: fixture.rootEnvelope.objectDigest,
      objectDigest: fixture.rootEnvelope.object.treeRootDigest,
      expectedKind: 'inventory-leaf',
      path: [],
    });
    expect(Object.isFrozen(loadInventoryObject.mock.calls[0]![0].path)).toBe(true);

    await expect(reconciler.advance(signal)).resolves.toMatchObject({
      status: 'complete',
      phase: 'complete',
      inventoryRequests: 0,
      processedRows: 1,
      pendingRows: 0,
      outcomes: [{ outcome: 'applied' }],
    });
    expect(consumeCandidate).toHaveBeenCalledTimes(1);
    expect(admission.stats()).toEqual({ active: 0, peak: 1, acquisitions: 2 });
    expect(reconciler.stats()).toMatchObject({
      admittedSlices: 2,
      advances: 2,
      inventoryRequests: 1,
      processedRows: 1,
      pendingRows: 0,
      active: 0,
      peakActive: 1,
      queued: 0,
    });
  });

  it('probes an ambiguous root kind across separate admitted slices', async () => {
    const fixture = await publishedFixture();
    const rootEnvelope = await resignRootTotalRows(fixture, '256');
    const loadInventoryObject = vi.fn(async () => ({
      outcome: 'rejected' as const,
      wireBytes: 128,
      rejection: 'not-found' as const,
    }));
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject,
      receiver: receiver(fixture.store, vi.fn()),
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'inventory',
      inventoryRequests: 1,
    });
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'inventory-not-found',
      inventoryRequests: 1,
    });
    expect(loadInventoryObject.mock.calls.map(([request]) => request.expectedKind))
      .toEqual(['inventory-leaf', 'inventory-internal']);
    expect(reconciler.stats()).toMatchObject({
      admittedSlices: 2,
      inventoryRequests: 2,
      queued: 0,
    });
  });

  it('rejects a response whose kind differs from the exact request', async () => {
    const fixture = await publishedFixture();
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject: async (request, signal) => {
        const loaded = await fixture.loadInventoryObject(request, signal);
        if (loaded?.outcome !== 'ok') return loaded;
        return { ...loaded, objectKind: 'inventory-internal' as const };
      },
      receiver: receiver(fixture.store, vi.fn()),
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'inventory-invalid-response',
      inventoryRequests: 1,
    });
    expect(reconciler.stats()).toMatchObject({ processedRows: 0, pendingRows: 0 });
  });

  it('defers without timers or I/O when shared admission is occupied', async () => {
    const fixture = await publishedFixture();
    const admission = admissionGate(true);
    const loadInventoryObject = vi.fn(fixture.loadInventoryObject);
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject,
      receiver: receiver(fixture.store, vi.fn()),
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'deferred',
      phase: 'inventory',
    });
    expect(loadInventoryObject).not.toHaveBeenCalled();
    expect(reconciler.stats()).toMatchObject({ admittedSlices: 0, active: 0, queued: 0 });
  });

  it('never queues a concurrent slice and releases admission after close aborts I/O', async () => {
    const fixture = await publishedFixture();
    const admission = admissionGate();
    const started = Promise.withResolvers<void>();
    const loadInventoryObject = vi.fn(async (
      _request: AgentProfileInventoryLoadRequestV1,
      _signal: AbortSignal,
    ) => {
      started.resolve();
      return new Promise<never>(() => undefined);
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject,
      receiver: receiver(fixture.store, vi.fn()),
    });

    const active = reconciler.advance(new AbortController().signal);
    await started.promise;
    await expect(reconciler.advance(new AbortController().signal))
      .rejects.toThrow(/already has an active slice/);
    reconciler.close();
    await expect(active).rejects.toThrow(/reconciler closed/);
    expect(admission.stats()).toMatchObject({ active: 0, peak: 1, acquisitions: 1 });
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'closed',
    });
  });

  it('retains a row until a nonterminal apply outcome can be retried', async () => {
    const fixture = await publishedFixture();
    const consumeCandidate = vi.fn()
      .mockResolvedValueOnce({ outcome: 'deferred', reason: 'state-changed' })
      .mockResolvedValueOnce({
        outcome: 'already-applied',
        stateRevision: '2',
        appliedStateDigest: `0x${'bb'.repeat(32)}`,
      });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject: fixture.loadInventoryObject,
      receiver: receiver(fixture.store, consumeCandidate),
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'apply-deferred',
      processedRows: 0,
      pendingRows: 1,
    });
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'complete',
      processedRows: 1,
      pendingRows: 0,
    });
    expect(consumeCandidate).toHaveBeenCalledTimes(2);
  });

  it('rejects an untrusted provider root before acquiring admission or loading inventory', async () => {
    const fixture = await publishedFixture();
    const admission = admissionGate();
    const loadInventoryObject = vi.fn(fixture.loadInventoryObject);

    await expect(createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: (
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      ) as typeof fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject,
      receiver: receiver(fixture.store, vi.fn()),
    })).rejects.toThrow(/provider signature is invalid/);
    expect(admission.stats().acquisitions).toBe(0);
    expect(loadInventoryObject).not.toHaveBeenCalled();
  });
});

async function publishedFixture() {
  const fixture = await producerFixture();
  const producer = createFixtureAgentProfileProducerV1({
    networkId: NETWORK,
    publicationDeployment: DEPLOYMENT,
    peerSigner: fixture.peerSigner,
    evmSigner: fixture.evmSigner,
    store: fixture.store,
    fence: () => undefined,
    install: () => undefined,
  });
  await produce(producer, fixture.prepared, fixture.publication);
  const rootArtifact = await fixture.store.resolve(
    { type: 'root' },
    new AbortController().signal,
  );
  if (rootArtifact === null) throw new Error('fixture root was not retained');
  const rootEnvelope = parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1(
    rootArtifact.canonicalBytes,
  );
  const inventory = fixture.store.snapshot().inventory;
  if (inventory === null) throw new Error('fixture inventory was not retained');

  return {
    ...fixture,
    rootEnvelope,
    loadInventoryObject: async (
      request: AgentProfileInventoryLoadRequestV1,
      signal: AbortSignal,
    ) => {
      const stored = inventory.objects.get(request.objectDigest);
      const objectKind = request.expectedKind ?? stored?.objectKind;
      if (objectKind === undefined) return undefined;
      const artifact = await fixture.store.resolve({
        type: 'inventory-object',
        rootDescriptorDigest: request.rootDescriptorDigest,
        path: request.path,
        objectKind,
        objectDigest: request.objectDigest,
      }, signal);
      return artifact === null
        ? undefined
        : {
          outcome: 'ok' as const,
          objectKind,
          canonicalBytes: artifact.canonicalBytes,
          wireBytes: 4 + 128 + artifact.canonicalBytes.byteLength,
        };
    },
  };
}

async function resignRootTotalRows(
  fixture: Awaited<ReturnType<typeof publishedFixture>>,
  totalRows: SignedSystemRecordRootDescriptorEnvelopeV1['object']['totalRows'],
): Promise<SignedSystemRecordRootDescriptorEnvelopeV1> {
  const object = Object.freeze({ ...fixture.rootEnvelope.object, totalRows });
  const objectDigest = computeSystemRecordRootDescriptorDigestV1(object);
  const signature = await fixture.peerSigner.sign(buildSystemRecordProviderSignatureMessageV1(
    object,
    objectDigest,
    fixture.peerSigner.peerId,
  ));
  return Object.freeze({
    object,
    objectDigest,
    providerPeerId: fixture.peerSigner.peerId,
    signatureSuite: 'ed25519-v1',
    signature: Buffer.from(signature).toString('base64url'),
  });
}

function receiver(
  store: SystemRecordArtifactRepositoryV1,
  consumeCandidate: Parameters<typeof createAgentProfileReceiverV1>[0]['consumeCandidate'],
) {
  return createAgentProfileReceiverV1({
    networkId: NETWORK,
    artifacts: store,
    nowMs: () => PRODUCER_FIXTURE_NOW_MS,
    verifyCurrentBundle: (_head, bundleBytes) => {
      const { projectionBytes } = decodeOpaqueKaBundleV1(bundleBytes);
      return Object.freeze({
        canonicalProjectionBytes: Uint8Array.from(projectionBytes),
        projectionQuads: Object.freeze(parseNQuads(new TextDecoder().decode(projectionBytes))),
      });
    },
    consumeCandidate,
  });
}

function admissionGate(initiallyHeld = false): AgentProfileReconcileAdmissionV1 & {
  stats(): { active: 0 | 1; peak: 0 | 1; acquisitions: number };
} {
  let held = initiallyHeld;
  let peak: 0 | 1 = held ? 1 : 0;
  let acquisitions = 0;
  return Object.freeze({
    tryAcquire() {
      if (held) return null;
      held = true;
      peak = 1;
      acquisitions += 1;
      let live = true;
      return Object.freeze({
        release() {
          if (!live) return;
          live = false;
          held = false;
        },
      });
    },
    stats() {
      return { active: held ? 1 : 0, peak, acquisitions };
    },
  });
}
