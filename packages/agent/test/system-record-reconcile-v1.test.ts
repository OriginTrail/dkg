import { describe, expect, it, vi } from 'vitest';

import {
  SYSTEM_RECORD_CONTINUATION_TIMEOUT_MS,
  SYSTEM_RECORD_MAX_CONTINUATION_CLOSURE_WIRE_BYTES,
  SYSTEM_RECORD_MAX_CONTINUATION_SLICES,
  SYSTEM_RECORD_MAX_CONTINUATION_WIRE_BYTES,
  buildSystemRecordInventoryTreeV1,
  computeSystemRecordStableKeyHashV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { AgentProfileAdmittedSliceContextV1 } from '../src/system-records/admitted-slice-context-v1.js';
import {
  createAgentProfileReceiverV1,
  type AgentProfileCandidateContinuationReceiverV1,
  type AgentProfileReceiverV1,
} from '../src/system-records/receiver-v1.js';
import {
  agentProfileReconcileWireContinuationLimitReachedV1,
  createAgentProfileReconcilerV1,
  type AgentProfileReconcileAdmissionV1,
  type AgentProfileInventoryLoadRequestV1,
} from '../src/system-records/reconcile-v1.js';
import {
  createAgentProfileReconcileTransportV1,
} from '../src/system-records/reconcile-transport-v1.js';
import type {
  SystemRecordExactArtifactLookupV1,
  SystemRecordExactFetchResultV1,
} from '../src/system-records/requester-v1.js';
import {
  TEST_PEER_IDS,
  admissionGate,
  byteAdmission,
  publishedFixture,
  receiver,
  receiverWithPreparation,
  resignRootTotalRows,
  signRootDescriptor,
} from './support/agent-profile-reconcile-v1-fixture.js';
import { NETWORK } from './support/agent-profile-producer-v1-fixture.js';
import { agentProfileArtifactSources } from './support/agent-profile-artifact-sources-v1-fixture.js';

describe('agent-profile System Record reconciler V1', () => {
  it('counts inventory and closure bytes together at the continuation limit', () => {
    const closureWireBytes = 1;
    expect(closureWireBytes).toBeLessThan(SYSTEM_RECORD_MAX_CONTINUATION_CLOSURE_WIRE_BYTES);
    expect(agentProfileReconcileWireContinuationLimitReachedV1(
      SYSTEM_RECORD_MAX_CONTINUATION_WIRE_BYTES - closureWireBytes - 1,
      closureWireBytes,
    )).toBe(false);
    expect(agentProfileReconcileWireContinuationLimitReachedV1(
      SYSTEM_RECORD_MAX_CONTINUATION_WIRE_BYTES - closureWireBytes,
      closureWireBytes,
    )).toBe(true);
  });

  it('pins one provider root and completes one active row across bounded slices', async () => {
    const fixture = await publishedFixture();
    const admission = admissionGate();
    const consumeCandidate = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '1',
      appliedStateDigest: `0x${'aa'.repeat(32)}`,
    }));
    const loadInventoryObject = vi.fn(fixture.loadInventoryObject);
    const continuationReceiver = receiver(fixture.store, consumeCandidate);
    const prepareActive = vi.fn(continuationReceiver.prepareActive.bind(continuationReceiver));
    const directReceiver: AgentProfileReceiverV1 = Object.freeze({
      prepareActive,
      receiveActive: continuationReceiver.receiveActive.bind(continuationReceiver),
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject,
      receiver: directReceiver,
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
    expect(prepareActive).toHaveBeenCalledTimes(1);
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
  ])('routes a $label row through receiver verification', async ({ patch }) => {
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
    const prepareCandidate = vi.fn(async () => {
      throw new Error('unsupported row fixture');
    });
    const loadInventoryObject = async (request: AgentProfileInventoryLoadRequestV1) => {
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
    };
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject,
      receiver: receiverWithPreparation(prepareCandidate),
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      pendingRows: 1,
    });
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'records',
      reason: 'receiver-verification-failed',
      processedRows: 0,
      pendingRows: 1,
    });
    expect(prepareCandidate).toHaveBeenCalledTimes(1);

    const prepareActive = vi.fn(async () => {
      throw new Error('legacy active receiver must not see a non-active row');
    });
    const receiveActive = vi.fn(async () => {
      throw new Error('direct reconcile does not use the receive convenience');
    });
    const activeOnlyReceiver: AgentProfileReceiverV1 = Object.freeze({
      prepareActive,
      receiveActive,
    });
    const activeOnlyReconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject,
      receiver: activeOnlyReceiver,
    });
    await activeOnlyReconciler.advance(new AbortController().signal);
    await expect(activeOnlyReconciler.advance(new AbortController().signal))
      .resolves.toMatchObject({
        status: 'blocked',
        phase: 'records',
        reason: 'receiver-verification-failed',
        processedRows: 0,
        pendingRows: 1,
      });
    expect(prepareActive).not.toHaveBeenCalled();
    expect(receiveActive).not.toHaveBeenCalled();
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

  it('does not consume continuation slices while the shared transport is busy', async () => {
    const fixture = await publishedFixture();
    const now = Date.now();
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      const artifact = await fixture.store.resolve(lookup, signal);
      if (artifact === null) return Object.freeze({ outcome: 'not-found', wireBytes: 1 });
      return Object.freeze({
        outcome: 'ok',
        lease: Object.freeze({
          artifact,
          wireBytes: 4 + 128 + artifact.canonicalBytes.byteLength,
          release: vi.fn(),
        }),
      });
    });
    const transport = createAgentProfileReconcileTransportV1({
      networkId: NETWORK,
      listProviderIds: () => ['provider-a'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const held = transport.openSlice(Object.freeze({
      signal: new AbortController().signal,
      deadlineMs: now + 3_000,
      nowMs: () => now,
    }));
    if (held === null) throw new Error('test transport was not initially available');
    const baseReceiver = receiver(fixture.store, vi.fn());
    const prepareCandidate = vi.fn(baseReceiver.prepareCandidate.bind(baseReceiver));
    const trackedReceiver: AgentProfileCandidateContinuationReceiverV1 = Object.freeze({
      openPreparation: baseReceiver.openPreparation.bind(baseReceiver),
      prepareCandidate,
      receiveCandidate: baseReceiver.receiveCandidate.bind(baseReceiver),
      prepareActive: baseReceiver.prepareActive.bind(baseReceiver),
      receiveActive: baseReceiver.receiveActive.bind(baseReceiver),
    });
    const admission = admissionGate(false, () => now);
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      transport,
      receiver: trackedReceiver,
    });

    for (let attempt = 0; attempt < SYSTEM_RECORD_MAX_CONTINUATION_SLICES + 2; attempt += 1) {
      await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
        status: 'deferred',
        phase: 'inventory',
      });
    }
    expect(reconciler.stats()).toMatchObject({ admittedSlices: 0, active: 0, queued: 0 });
    expect(prepareCandidate).not.toHaveBeenCalled();
    expect(fetchExact).not.toHaveBeenCalled();
    expect(admission.stats()).toMatchObject({ active: 0 });

    held.release();
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
    });
    expect(reconciler.stats()).toMatchObject({ admittedSlices: 1 });
    expect(prepareCandidate).not.toHaveBeenCalled();
    expect(fetchExact).toHaveBeenCalledTimes(1);
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

  it('consumes a stale row as a settled outcome', async () => {
    const fixture = await publishedFixture();
    const consumeCandidate = vi.fn(async () => ({ outcome: 'stale' as const }));
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
      status: 'complete',
      phase: 'complete',
      processedRows: 1,
      pendingRows: 0,
      outcomes: [{ outcome: 'stale' }],
    });
    expect(consumeCandidate).toHaveBeenCalledTimes(1);
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

  it('returns prior settlements when later receiver verification fails', async () => {
    const fixture = await publishedFixture();
    const headEnvelope = fixture.store.snapshot().currentHead;
    if (headEnvelope === null) throw new Error('fixture active head was not retained');
    const rows = TEST_PEER_IDS.slice(0, 2).map((peerId): SystemRecordInventoryRowV1 => ({
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
    const apply = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '9',
      appliedStateDigest: `0x${'ff'.repeat(32)}`,
    }));
    const prepareActive = vi.fn()
      .mockResolvedValueOnce(Object.freeze({ apply }))
      .mockRejectedValueOnce(new Error('missing exact profile closure'));
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject: async (request) => {
        const stored = inventory.objects.get(request.objectDigest)!;
        return Object.freeze({
          outcome: 'ok' as const,
          objectKind: stored.objectKind,
          canonicalBytes: stored.canonicalBytes,
          wireBytes: 4 + 128 + stored.canonicalBytes.byteLength,
        });
      },
      receiver: receiverWithPreparation(prepareActive),
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'records',
      reason: 'receiver-verification-failed',
      processedRows: 1,
      pendingRows: 1,
      outcomes: [{ outcome: 'applied' }],
    });
    expect(prepareActive).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(reconciler.stats()).toMatchObject({ processedRows: 1, pendingRows: 1 });
  });

  it('returns a committed first-row outcome when the caller aborts during dispatch', async () => {
    const fixture = await publishedFixture();
    const headEnvelope = fixture.store.snapshot().currentHead;
    if (headEnvelope === null) throw new Error('fixture active head was not retained');
    const rows = TEST_PEER_IDS.slice(0, 2).map((peerId): SystemRecordInventoryRowV1 => ({
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
    const dispatched = Promise.withResolvers<void>();
    const settlement = Promise.withResolvers<{
      outcome: 'applied';
      stateRevision: string;
      appliedStateDigest: `0x${string}`;
    }>();
    const apply = vi.fn(async () => {
      dispatched.resolve();
      return settlement.promise;
    });
    const prepareActive = vi.fn(async () => Object.freeze({ apply }));
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject: async (request) => {
        const stored = inventory.objects.get(request.objectDigest)!;
        return Object.freeze({
          outcome: 'ok' as const,
          objectKind: stored.objectKind,
          canonicalBytes: stored.canonicalBytes,
          wireBytes: 4 + 128 + stored.canonicalBytes.byteLength,
        });
      },
      receiver: receiverWithPreparation(prepareActive),
    });

    await reconciler.advance(new AbortController().signal);
    const caller = new AbortController();
    const active = reconciler.advance(caller.signal);
    await dispatched.promise;
    caller.abort(new Error('caller aborted after atomic dispatch'));
    settlement.resolve({
      outcome: 'applied',
      stateRevision: '10',
      appliedStateDigest: `0x${'ab'.repeat(32)}`,
    });

    await expect(active).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      processedRows: 1,
      pendingRows: 1,
      outcomes: [{
        outcome: 'applied',
        stateRevision: '10',
        appliedStateDigest: `0x${'ab'.repeat(32)}`,
      }],
    });
    expect(prepareActive).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(admission.stats()).toEqual({ active: 0, peak: 1, acquisitions: 2 });
    expect(reconciler.stats()).toMatchObject({ processedRows: 1, pendingRows: 1, active: 0 });
  });

  it('blocks when a verified head expires before prepared apply dispatch', async () => {
    const fixture = await publishedFixture();
    const headEnvelope = fixture.store.snapshot().currentHead;
    if (headEnvelope === null) throw new Error('fixture active head was not retained');
    const validUntilMs = Date.parse(headEnvelope.object.validUntil);
    const nowMs = vi.fn()
      .mockReturnValueOnce(validUntilMs - 1)
      .mockReturnValue(validUntilMs);
    const materialize = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '10',
      appliedStateDigest: `0x${'aa'.repeat(32)}`,
    }));
    const prepareCandidateApply = vi.fn(() => Object.freeze({
      existingMonotonicDeadlineMs: 10_000,
      monotonicNowMs: 1_000,
      apply: materialize,
    }));
    const activeReceiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: agentProfileArtifactSources(fixture.store),
      nowMs,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject: fixture.loadInventoryObject,
      receiver: activeReceiver,
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'records',
      reason: 'receiver-verification-failed',
      processedRows: 0,
      pendingRows: 1,
      outcomes: [],
    });
    expect(nowMs).toHaveBeenCalledTimes(2);
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
    expect(materialize).not.toHaveBeenCalled();
  });

  it('does not classify a materializer rejection as a predispatch failure', async () => {
    const fixture = await publishedFixture();
    const settlementFailure = new Error('atomic materializer settlement failed');
    const materialize = vi.fn(async () => {
      throw settlementFailure;
    });
    const preparedReceiver = receiverWithPreparation(async () => Object.freeze({
      apply: materialize,
    }));
    const admission = admissionGate();
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject: fixture.loadInventoryObject,
      receiver: preparedReceiver,
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal))
      .rejects.toBe(settlementFailure);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(admission.stats().active).toBe(0);
    expect(reconciler.stats()).toMatchObject({ processedRows: 0, pendingRows: 1 });
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
