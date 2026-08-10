import { describe, expect, it, vi } from 'vitest';

import {
  SYSTEM_RECORD_MAX_CONTINUATION_CLOSURE_WIRE_BYTES,
  SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { SystemRecordArtifactRepositoryV1 } from '../src/system-records/artifact-v1.js';
import type {
  AgentProfileContinuationReceiverV1,
} from '../src/system-records/receiver-v1.js';
import { createAgentProfileReconcilerV1 } from '../src/system-records/reconcile-v1.js';
import { createAgentProfileReconcileTransportV1 } from '../src/system-records/reconcile-transport-v1.js';
import type {
  SystemRecordExactArtifactLookupV1,
  SystemRecordExactFetchResultV1,
} from '../src/system-records/requester-v1.js';
import {
  admissionGate,
  byteAdmission,
  publishedFixture,
  receiver,
} from './support/agent-profile-reconcile-v1-fixture.js';
import { NETWORK } from './support/agent-profile-producer-v1-fixture.js';

describe('agent-profile reconciler exact transport integration V1', () => {
  it('routes inventory and receiver closure fetches through one admitted transport slice', async () => {
    const fixture = await publishedFixture();
    const released: ReturnType<typeof vi.fn>[] = [];
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      const artifact = await fixture.store.resolve(lookup, signal);
      if (artifact === null) return Object.freeze({ outcome: 'not-found', wireBytes: 5 });
      const release = vi.fn();
      released.push(release);
      return Object.freeze({
        outcome: 'ok',
        lease: Object.freeze({
          artifact,
          wireBytes: 4 + 128 + artifact.canonicalBytes.byteLength,
          release,
        }),
      });
    });
    const transport = createAgentProfileReconcileTransportV1({
      networkId: NETWORK,
      listProviderIds: () => ['provider-a'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const consumeCandidate = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '1',
      appliedStateDigest: `0x${'aa'.repeat(32)}`,
    }));
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: receiver(fixture.store, consumeCandidate),
    });

    const inventoryResult = await reconciler.advance(new AbortController().signal);
    expect(inventoryResult).toMatchObject({
      status: 'paused',
      phase: 'records',
      inventoryRequests: 1,
      closureWireBytes: 0,
    });
    const wireBytesAfterInventory = transport.stats().wireBytes;
    expect(transport.stats()).toMatchObject({ activeSlice: 0, requests: 1 });
    expect(released).toHaveLength(1);
    expect(released[0]).toHaveBeenCalledTimes(1);

    const recordsResult = await reconciler.advance(new AbortController().signal);
    expect(recordsResult).toMatchObject({ status: 'complete', processedRows: 1 });
    const closureWireBytes = transport.stats().wireBytes - wireBytesAfterInventory;
    expect(recordsResult.closureWireBytes).toBe(closureWireBytes);
    expect(reconciler.stats().closureWireBytes).toBe(closureWireBytes);
    expect(consumeCandidate).toHaveBeenCalledTimes(1);
    expect(fetchExact.mock.calls.every(([, lookup]) => lookup.type !== 'root')).toBe(true);
    expect(fetchExact.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(released.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(transport.stats()).toMatchObject({
      activeSlice: 0,
      requests: fetchExact.mock.calls.length,
      negativeMemoEntries: 0,
    });
  });

  it('accounts every failed and successful provider attempt in inventory bytes', async () => {
    const fixture = await publishedFixture();
    let successfulInventoryBytes = 0;
    const fetchExact = vi.fn(async (
      providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (providerId === 'provider-a' && lookup.type === 'inventory-object') {
        return Object.freeze({ outcome: 'not-found', wireBytes: 1_000 });
      }
      const artifact = await fixture.store.resolve(lookup, signal);
      if (artifact === null) return Object.freeze({ outcome: 'not-found', wireBytes: 1 });
      successfulInventoryBytes = 4 + 128 + artifact.canonicalBytes.byteLength;
      return Object.freeze({
        outcome: 'ok',
        lease: Object.freeze({
          artifact,
          wireBytes: successfulInventoryBytes,
          release: vi.fn(),
        }),
      });
    });
    const transport = createAgentProfileReconcileTransportV1({
      networkId: NETWORK,
      listProviderIds: () => ['provider-a', 'provider-b'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: receiver(fixture.store, vi.fn()),
    });

    const result = await reconciler.advance(new AbortController().signal);
    expect(result).toMatchObject({
      status: 'paused',
      phase: 'records',
      inventoryRequests: 1,
      inventoryWireBytes: 1_000 + successfulInventoryBytes,
    });
    expect(reconciler.stats()).toMatchObject({
      inventoryRequests: 1,
      inventoryWireBytes: 1_000 + successfulInventoryBytes,
    });
    expect(fetchExact.mock.calls.map(([providerId]) => providerId))
      .toEqual(['provider-a', 'provider-b']);
  });

  it('pauses and accounts a retryable failure during closure preparation', async () => {
    const fixture = await publishedFixture();
    let closureBusy = true;
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (lookup.type !== 'inventory-object' && closureBusy) {
        return Object.freeze({ outcome: 'remote-busy', wireBytes: 13 });
      }
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
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: receiver(fixture.store, async () => ({
        outcome: 'applied',
        stateRevision: '1',
        appliedStateDigest: `0x${'aa'.repeat(32)}`,
      })),
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      closureWireBytes: 13,
      pendingRows: 1,
    });
    expect(reconciler.stats()).toMatchObject({
      advances: 1,
      closureWireBytes: 13,
      pendingRows: 1,
    });

    closureBusy = false;
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'complete',
      processedRows: 1,
    });
  });

  it('blocks and releases retained closure state after an invalid response', async () => {
    const fixture = await publishedFixture();
    let closureRequests = 0;
    const closureReleases: ReturnType<typeof vi.fn>[] = [];
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (lookup.type !== 'inventory-object') {
        closureRequests += 1;
        if (closureRequests === 2) {
          return Object.freeze({ outcome: 'invalid-response', wireBytes: 13 });
        }
      }
      const artifact = await fixture.store.resolve(lookup, signal);
      if (artifact === null) return Object.freeze({ outcome: 'not-found', wireBytes: 1 });
      const release = vi.fn();
      if (lookup.type !== 'inventory-object') closureReleases.push(release);
      return Object.freeze({
        outcome: 'ok',
        lease: Object.freeze({
          artifact,
          wireBytes: 4 + 128 + artifact.canonicalBytes.byteLength,
          release,
        }),
      });
    });
    const transport = createAgentProfileReconcileTransportV1({
      networkId: NETWORK,
      listProviderIds: () => ['provider-a'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const consumeCandidate = vi.fn();
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: receiver(fixture.store, consumeCandidate),
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'records',
      reason: 'receiver-verification-failed',
      pendingRows: 1,
    });
    expect(closureRequests).toBe(2);
    expect(consumeCandidate).not.toHaveBeenCalled();
    expect(closureReleases).toHaveLength(1);
    expect(closureReleases[0]).toHaveBeenCalledTimes(1);
    expect(transport.stats()).toMatchObject({
      activeSlice: 0,
      retainedContinuationArtifacts: 0,
      retainedContinuationBytes: 0,
      retainedContinuationControlBytes: 0,
    });
    expect(reconciler.stats()).toMatchObject({
      processedRows: 0,
      pendingRows: 1,
      retainedClosureArtifacts: 0,
      retainedClosureBytes: 0,
    });
  });

  it('stops at the dedicated closure wire-byte continuation budget', async () => {
    const fixture = await publishedFixture();
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (lookup.type !== 'inventory-object') {
        return Object.freeze({
          outcome: 'remote-error',
          wireBytes: SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES / 2,
        });
      }
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
      listProviderIds: () => ['provider-a', 'provider-b'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const apply = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '1',
      appliedStateDigest: `0x${'aa'.repeat(32)}`,
    }));
    const artifacts = fixture.store;
    const prepareFromSource = async (
      row: SystemRecordInventoryRowV1,
      source: SystemRecordArtifactRepositoryV1,
      signal: AbortSignal,
    ) => {
      await source.resolve(Object.freeze({
        type: 'object',
        objectKind: 'agent-profile-head',
        objectDigest: row.headDigest,
      }), signal);
      return Object.freeze({
        async prepareDispatch(admittedContext, dispatchSignal) {
          dispatchSignal.throwIfAborted();
          return Object.freeze({
            dispatch: () => apply(admittedContext, dispatchSignal),
          });
        },
      });
    };
    const receiverWithRemotePreparation: AgentProfileContinuationReceiverV1 = Object.freeze({
      openPreparation(row) {
        return Object.freeze({
          prepare: (source, signal) => prepareFromSource(row, source, signal),
          release: () => undefined,
        });
      },
      prepareActive: (row, signal) => prepareFromSource(row, artifacts, signal),
      async receiveActive(row, admittedContext, signal) {
        const prepared = await prepareFromSource(row, artifacts, signal);
        const dispatch = await prepared.prepareDispatch(admittedContext, signal);
        return dispatch.dispatch();
      },
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: receiverWithRemotePreparation,
    });

    await reconciler.advance(new AbortController().signal);
    const closureSlices = SYSTEM_RECORD_MAX_CONTINUATION_CLOSURE_WIRE_BYTES
      / SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES;
    for (let slice = 0; slice < closureSlices; slice += 1) {
      const result = await reconciler.advance(new AbortController().signal);
      if (result.status !== 'paused') {
        throw new Error(`unexpected slice ${slice}: ${JSON.stringify({
          result,
          stats: reconciler.stats(),
        })}`);
      }
      expect(result).toMatchObject({
        status: 'paused',
        phase: 'records',
        closureWireBytes: SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
      });
    }
    expect(reconciler.stats()).toMatchObject({
      closureWireBytes: SYSTEM_RECORD_MAX_CONTINUATION_CLOSURE_WIRE_BYTES,
      processedRows: 0,
      pendingRows: 1,
    });
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'continuation-limit',
      closureWireBytes: 0,
    });
    expect(apply).not.toHaveBeenCalled();
  });
});
