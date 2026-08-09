import { describe, expect, it, vi } from 'vitest';

import { decodeOpaqueKaBundleV1 } from '@origintrail-official/dkg-core';
import {
  SYSTEM_RECORD_CONTINUATION_TIMEOUT_MS,
  buildSystemRecordInventoryTreeV1,
  buildSystemRecordProviderSignatureMessageV1,
  computeSystemRecordRootDescriptorDigestV1,
  computeSystemRecordStableKeyHashV1,
  parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { parseNQuads } from '../src/dkg-agent-utils.js';
import type { AgentProfileAdmittedSliceContextV1 } from '../src/system-records/admitted-slice-context-v1.js';
import type { SystemRecordArtifactRepositoryV1 } from '../src/system-records/artifact-v1.js';
import {
  createAgentProfileReceiverV1,
  type AgentProfileReceiverV1,
} from '../src/system-records/receiver-v1.js';
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

const TEST_PEER_IDS = Object.freeze([
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkf',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkg',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkh',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwki',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkj',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkk',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkm',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkn',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwko',
]);

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
    expect(consumeCandidate.mock.calls[0]![1]).toBe(admission.lastContext());
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

  it('retains rows beyond the eight-apply physical slice limit', async () => {
    const fixture = await publishedFixture();
    const headEnvelope = fixture.store.snapshot().currentHead;
    if (headEnvelope === null) throw new Error('fixture active head was not retained');
    const rows = TEST_PEER_IDS.map((peerId): SystemRecordInventoryRowV1 => ({
      stableKeyHash: computeSystemRecordStableKeyHashV1(NETWORK, peerId),
      peerId,
      authoritySequence: headEnvelope.object.authoritySequence,
      version: headEnvelope.object.version,
      headDigest: headEnvelope.objectDigest,
      tombstone: false,
      quarantined: false,
    }));
    const inventory = buildSystemRecordInventoryTreeV1(NETWORK, rows);
    const rootEnvelope = await signRootDescriptor(fixture, inventory.descriptor);
    const admission = admissionGate();
    const apply = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '5',
      appliedStateDigest: `0x${'ee'.repeat(32)}`,
    }));
    const prepareActive = vi.fn(async () => Object.freeze({ apply }));
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject: async (request) => {
        const stored = inventory.objects.get(request.objectDigest);
        return stored === undefined
          ? Object.freeze({
              outcome: 'rejected' as const,
              wireBytes: 0,
              rejection: 'not-found' as const,
            })
          : Object.freeze({
              outcome: 'ok' as const,
              objectKind: stored.objectKind,
              canonicalBytes: stored.canonicalBytes,
              wireBytes: 4 + 128 + stored.canonicalBytes.byteLength,
            });
      },
      receiver: receiverWithPreparation(prepareActive),
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      pendingRows: 9,
    });
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      processedRows: 8,
      pendingRows: 1,
    });
    expect(prepareActive).toHaveBeenCalledTimes(8);
    expect(apply).toHaveBeenCalledTimes(8);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'complete',
      processedRows: 1,
      pendingRows: 0,
    });
    expect(prepareActive).toHaveBeenCalledTimes(9);
    expect(apply).toHaveBeenCalledTimes(9);
    expect(admission.stats()).toEqual({ active: 0, peak: 1, acquisitions: 3 });
    expect(reconciler.stats()).toMatchObject({ processedRows: 9, pendingRows: 0 });
  });

  it('enforces the continuation wall-clock cap across admitted slices', async () => {
    const fixture = await publishedFixture();
    let nowMs = 0;
    const admission = admissionGate(false, () => nowMs);
    const apply = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '5',
      appliedStateDigest: `0x${'ee'.repeat(32)}`,
    }));
    const prepareActive = vi.fn(async () => Object.freeze({ apply }));
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject: fixture.loadInventoryObject,
      receiver: receiverWithPreparation(prepareActive),
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      pendingRows: 1,
    });
    nowMs = SYSTEM_RECORD_CONTINUATION_TIMEOUT_MS;
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'records',
      reason: 'continuation-limit',
      processedRows: 0,
      pendingRows: 1,
    });
    expect(prepareActive).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(admission.stats()).toEqual({ active: 0, peak: 1, acquisitions: 2 });
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

  it.each([
    {
      label: 'tombstone',
      patch: { tombstone: true },
    },
    {
      label: 'quarantined conflict-evidence',
      patch: {
        quarantined: true,
        conflictEvidenceDigest: `0x${'dd'.repeat(32)}` as const,
      },
    },
  ])('retains an unsupported $label row without receiver dispatch', async ({ patch }) => {
    const fixture = await publishedFixture();
    const headEnvelope = fixture.store.snapshot().currentHead;
    if (headEnvelope === null) throw new Error('fixture active head was not retained');
    const unsupportedRow: SystemRecordInventoryRowV1 = {
      stableKeyHash: computeSystemRecordStableKeyHashV1(NETWORK, fixture.peerSigner.peerId),
      peerId: fixture.peerSigner.peerId,
      authoritySequence: headEnvelope.object.authoritySequence,
      version: headEnvelope.object.version,
      headDigest: headEnvelope.objectDigest,
      tombstone: false,
      quarantined: false,
      ...patch,
    };
    const inventory = buildSystemRecordInventoryTreeV1(NETWORK, [unsupportedRow]);
    const rootEnvelope = await signRootDescriptor(fixture, inventory.descriptor);
    const prepareActive = vi.fn();
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject: async (request) => {
        const stored = inventory.objects.get(request.objectDigest);
        if (stored === undefined) {
          return Object.freeze({
            outcome: 'rejected' as const,
            wireBytes: 0,
            rejection: 'not-found' as const,
          });
        }
        return Object.freeze({
          outcome: 'ok' as const,
          objectKind: stored.objectKind,
          canonicalBytes: stored.canonicalBytes,
          wireBytes: 4 + 128 + stored.canonicalBytes.byteLength,
        });
      },
      receiver: receiverWithPreparation(prepareActive),
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      pendingRows: 1,
    });
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'records',
      reason: 'unsupported-row-state',
      processedRows: 0,
      pendingRows: 1,
    });
    expect(prepareActive).not.toHaveBeenCalled();
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
    await expect(active).resolves.toMatchObject({
      status: 'closed',
      inventoryRequests: 1,
      inventoryWireBytes: 0,
    });
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

  it.each([
    {
      outcome: { outcome: 'root-collision' as const },
      reason: 'apply-root-collision',
    },
    {
      outcome: { outcome: 'capacity-exhausted' as const },
      reason: 'apply-capacity-exhausted',
    },
    {
      outcome: { outcome: 'indeterminate' as const, recoveryGeneration: '7' },
      reason: 'apply-indeterminate',
    },
    {
      outcome: { outcome: 'capability-lost' as const },
      reason: 'apply-capability-lost',
    },
  ])('retains a row after $outcome.outcome', async ({ outcome, reason }) => {
    const fixture = await publishedFixture();
    const apply = vi.fn(async () => outcome);
    const prepareActive = vi.fn(async () => Object.freeze({ apply }));
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject: fixture.loadInventoryObject,
      receiver: receiverWithPreparation(prepareActive),
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'records',
      reason,
      processedRows: 0,
      pendingRows: 1,
      outcomes: [outcome],
    });
    expect(prepareActive).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('releases admission when close aborts a stalled predispatch receiver', async () => {
    const fixture = await publishedFixture();
    const admission = admissionGate();
    const started = Promise.withResolvers<void>();
    const stalledReceiver = receiverWithPreparation(async () => {
      started.resolve();
      return new Promise<never>(() => undefined);
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject: fixture.loadInventoryObject,
      receiver: stalledReceiver,
    });

    await reconciler.advance(new AbortController().signal);
    const active = reconciler.advance(new AbortController().signal);
    await started.promise;
    reconciler.close();

    await expect(active).resolves.toMatchObject({
      status: 'closed',
      phase: 'records',
      pendingRows: 1,
    });
    expect(admission.stats()).toEqual({ active: 0, peak: 1, acquisitions: 2 });
    expect(reconciler.stats()).toMatchObject({ active: 0, queued: 0, closed: true });
  });

  it('releases admission at the original deadline when predispatch receiver work stalls', async () => {
    const fixture = await publishedFixture();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T00:00:00.000Z'));
    try {
      const admission = admissionGate();
      const started = Promise.withResolvers<void>();
      const stalledReceiver = receiverWithPreparation(async () => {
        started.resolve();
        return new Promise<never>(() => undefined);
      });
      const reconciler = await createAgentProfileReconcilerV1({
        networkId: NETWORK,
        rootEnvelope: fixture.rootEnvelope,
        providerPeerPublicKey: fixture.peerSigner.publicKey,
        admission,
        loadInventoryObject: fixture.loadInventoryObject,
        receiver: stalledReceiver,
      });

      await reconciler.advance(new AbortController().signal);
      const active = reconciler.advance(new AbortController().signal);
      await started.promise;
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(active).resolves.toMatchObject({
        status: 'paused',
        phase: 'records',
        pendingRows: 1,
      });
      expect(admission.stats()).toEqual({ active: 0, peak: 1, acquisitions: 2 });
      expect(reconciler.stats()).toMatchObject({ active: 0, queued: 0, closed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not dispatch a prepared apply without the required admitted budget', async () => {
    const fixture = await publishedFixture();
    let nowMs = 1_000;
    const admission = admissionGate(false, () => nowMs);
    const apply = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '4',
      appliedStateDigest: `0x${'dd'.repeat(32)}`,
    }));
    const preparedReceiver = receiverWithPreparation(async () => {
      nowMs = 2_501;
      return Object.freeze({ apply });
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject: fixture.loadInventoryObject,
      receiver: preparedReceiver,
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      processedRows: 0,
      pendingRows: 1,
      outcomes: [],
    });
    expect(apply).not.toHaveBeenCalled();
    expect(admission.stats()).toEqual({ active: 0, peak: 1, acquisitions: 2 });
  });

  it('awaits physical settlement after atomic apply dispatch even when closed', async () => {
    const fixture = await publishedFixture();
    const admission = admissionGate();
    const dispatched = Promise.withResolvers<void>();
    const applyResult = Promise.withResolvers<{
      outcome: 'applied';
      stateRevision: string;
      appliedStateDigest: `0x${string}`;
    }>();
    const preparedReceiver = receiverWithPreparation(async () => Object.freeze({
      async apply() {
        dispatched.resolve();
        return applyResult.promise;
      },
    }));
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject: fixture.loadInventoryObject,
      receiver: preparedReceiver,
    });

    await reconciler.advance(new AbortController().signal);
    let settled = false;
    const active = reconciler.advance(new AbortController().signal);
    void active.then(() => { settled = true; });
    await dispatched.promise;
    reconciler.close();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(admission.stats().active).toBe(1);

    applyResult.resolve({
      outcome: 'applied',
      stateRevision: '3',
      appliedStateDigest: `0x${'cc'.repeat(32)}`,
    });
    await expect(active).resolves.toMatchObject({
      status: 'complete',
      outcomes: [{ outcome: 'applied' }],
      pendingRows: 0,
    });
    expect(admission.stats()).toEqual({ active: 0, peak: 1, acquisitions: 2 });
  });

  it('releases an acquired permit when the admission clock is invalid', async () => {
    const fixture = await publishedFixture();
    const context = Object.freeze(Object.create(null)) as AgentProfileAdmittedSliceContextV1;
    const release = vi.fn();
    const admission: AgentProfileReconcileAdmissionV1 = Object.freeze({
      tryAcquire: () => Object.freeze({ admittedContext: context, release }),
      inspectAdmittedContext: () => Object.freeze({ nowMs: -1, admittedDeadlineMs: 3_000 }),
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject: fixture.loadInventoryObject,
      receiver: receiver(fixture.store, vi.fn()),
    });

    await expect(reconciler.advance(new AbortController().signal))
      .rejects.toThrow(/invalid monotonic deadline/);
    expect(release).toHaveBeenCalledTimes(1);
    expect(reconciler.stats()).toMatchObject({
      admittedSlices: 0,
      active: 0,
      queued: 0,
    });
  });

  it('rejects an admitted context whose original deadline changes', async () => {
    const fixture = await publishedFixture();
    const context = Object.freeze(Object.create(null)) as AgentProfileAdmittedSliceContextV1;
    const release = vi.fn();
    const loadInventoryObject = vi.fn(fixture.loadInventoryObject);
    const apply = vi.fn();
    const prepareActive = vi.fn(async () => Object.freeze({ apply }));
    let inspections = 0;
    const admission: AgentProfileReconcileAdmissionV1 = Object.freeze({
      tryAcquire: () => Object.freeze({ admittedContext: context, release }),
      inspectAdmittedContext: () => {
        inspections += 1;
        return inspections === 1
          ? Object.freeze({ nowMs: 1_000, admittedDeadlineMs: 4_000 })
          : Object.freeze({ nowMs: 1_200, admittedDeadlineMs: 4_200 });
      },
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject,
      receiver: receiverWithPreparation(prepareActive),
    });

    await expect(reconciler.advance(new AbortController().signal))
      .rejects.toThrow(/clock failed/);
    expect(inspections).toBe(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(loadInventoryObject).not.toHaveBeenCalled();
    expect(prepareActive).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(reconciler.stats()).toMatchObject({ admittedSlices: 1, active: 0, queued: 0 });
  });

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
      const objectKind = request.expectedKind;
      const artifact = await fixture.store.resolve({
        type: 'inventory-object',
        rootDescriptorDigest: request.rootDescriptorDigest,
        path: request.path,
        objectKind,
        objectDigest: request.objectDigest,
      }, signal);
      return artifact === null
        ? {
            outcome: 'rejected' as const,
            wireBytes: 6,
            rejection: 'not-found' as const,
          }
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
  return signRootDescriptor(fixture, object);
}

async function signRootDescriptor(
  fixture: Awaited<ReturnType<typeof publishedFixture>>,
  object: SignedSystemRecordRootDescriptorEnvelopeV1['object'],
): Promise<SignedSystemRecordRootDescriptorEnvelopeV1> {
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

function receiverWithPreparation(
  prepareActive: AgentProfileReceiverV1['prepareActive'],
): AgentProfileReceiverV1 {
  const receiver: AgentProfileReceiverV1 = Object.freeze({
    prepareActive,
    async receiveActive(row, admittedContext, signal) {
      const prepared = await prepareActive(row, signal);
      signal.throwIfAborted();
      return prepared.apply(admittedContext, signal);
    },
  });
  return receiver;
}

function admissionGate(
  initiallyHeld = false,
  nowMs: () => number = Date.now,
): AgentProfileReconcileAdmissionV1 & {
  stats(): { active: 0 | 1; peak: 0 | 1; acquisitions: number };
  lastContext(): AgentProfileAdmittedSliceContextV1 | undefined;
} {
  let held = initiallyHeld;
  let peak: 0 | 1 = held ? 1 : 0;
  let acquisitions = 0;
  let lastContext: AgentProfileAdmittedSliceContextV1 | undefined;
  const contexts = new WeakMap<object, number>();
  return Object.freeze({
    tryAcquire() {
      if (held) return null;
      held = true;
      peak = 1;
      acquisitions += 1;
      const context = Object.freeze(Object.create(null)) as AgentProfileAdmittedSliceContextV1;
      contexts.set(context, nowMs() + 3_000);
      lastContext = context;
      let live = true;
      return Object.freeze({
        admittedContext: context,
        release() {
          if (!live) return;
          live = false;
          held = false;
        },
      });
    },
    inspectAdmittedContext(context) {
      const admittedDeadlineMs = contexts.get(context);
      if (admittedDeadlineMs === undefined) throw new Error('test admitted context is invalid');
      return Object.freeze({ nowMs: nowMs(), admittedDeadlineMs });
    },
    stats() {
      return { active: held ? 1 : 0, peak, acquisitions };
    },
    lastContext() {
      return lastContext;
    },
  });
}
