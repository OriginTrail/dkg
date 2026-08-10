import { describe, expect, it, vi } from 'vitest';

import {
  SYSTEM_RECORD_MAX_CONTINUATION_CLOSURE_WIRE_BYTES,
  SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type {
  AgentProfileArtifactSourcesV1,
  AgentProfileCandidateContinuationReceiverV1,
  AgentProfileContinuationReceiverV1,
  AgentProfileReceiverAnyCandidateV1,
} from '../src/system-records/receiver-v1.js';
import { createAgentProfileCandidateReceiverV1 } from '../src/system-records/receiver-v1.js';
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
import { conflictReconcileFixture } from './support/agent-profile-conflict-reconcile-v1-fixture.js';
import { NETWORK } from './support/agent-profile-producer-v1-fixture.js';
import { agentProfileArtifactSources } from './support/agent-profile-artifact-sources-v1-fixture.js';

describe('agent-profile reconciler exact transport integration V1', () => {
  it('reports unsupported non-active rows before transport receiver preparation', async () => {
    const fixture = await conflictReconcileFixture('active');
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      const artifact = await fixture.repository.resolve(lookup, signal);
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
    const openPreparation = vi.fn();
    const prepareActive = vi.fn(async () => {
      throw new Error('active-only receiver must not prepare a quarantined row');
    });
    const receiveActive = vi.fn(async () => {
      throw new Error('active-only receiver must not receive a quarantined row');
    });
    const activeOnlyReceiver: AgentProfileContinuationReceiverV1 = Object.freeze({
      openPreparation(row) {
        openPreparation(row);
        throw new Error('active-only continuation must not open a quarantined row');
      },
      prepareActive,
      receiveActive,
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: activeOnlyReceiver,
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      pendingRows: 1,
    });
    const requestsAfterInventory = fetchExact.mock.calls.length;
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'records',
      reason: 'unsupported-row-state',
      pendingRows: 1,
    });
    expect(fetchExact).toHaveBeenCalledTimes(requestsAfterInventory);
    expect(openPreparation).not.toHaveBeenCalled();
    expect(prepareActive).not.toHaveBeenCalled();
    expect(receiveActive).not.toHaveBeenCalled();
    expect(reconciler.stats()).toMatchObject({
      retainedClosureArtifacts: 0,
      retainedSidecarArtifacts: 0,
    });
  });

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
      source: AgentProfileArtifactSourcesV1,
      signal: AbortSignal,
    ) => {
      await source.closureArtifacts.resolve(Object.freeze({
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
    const receiverWithRemotePreparation: AgentProfileCandidateContinuationReceiverV1 = Object.freeze({
      openPreparation(row) {
        return Object.freeze({
          prepare: (source, signal) => prepareFromSource(row, source, signal),
          release: () => undefined,
        });
      },
      prepareCandidate: (row, signal) => prepareFromSource(
        row,
        Object.freeze({ closureArtifacts: artifacts, securitySidecarArtifacts: artifacts }),
        signal,
      ),
      async receiveCandidate(row, admittedContext, signal) {
        const prepared = await receiverWithRemotePreparation.prepareCandidate(row, signal);
        const dispatch = await prepared.prepareDispatch(admittedContext, signal);
        return dispatch.dispatch();
      },
      prepareActive: (row, signal) => receiverWithRemotePreparation.prepareCandidate(row, signal),
      receiveActive: (row, admittedContext, signal) =>
        receiverWithRemotePreparation.receiveCandidate(row, admittedContext, signal),
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

  it('fails over and applies a verified ordinary fork as quarantine', async () => {
    const fixture = await conflictReconcileFixture('active');
    const candidates: AgentProfileReceiverAnyCandidateV1[] = [];
    const fetchExact = vi.fn(async (
      providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (providerId === 'provider-a'
          && lookup.type === 'object'
          && lookup.objectKind === 'conflict-evidence') {
        return Object.freeze({ outcome: 'not-found', wireBytes: 7 });
      }
      const artifact = await fixture.repository.resolve(lookup, signal);
      if (artifact === null) return Object.freeze({ outcome: 'not-found', wireBytes: 3 });
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
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: receiver(fixture.repository, async (candidate) => {
        candidates.push(candidate);
        return {
          outcome: 'applied',
          stateRevision: '12',
          appliedStateDigest: `0x${'c'.repeat(64)}`,
        };
      }),
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'complete',
      processedRows: 1,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.operation).toBe('quarantine');
    expect(fetchExact.mock.calls.filter(([, lookup]) =>
      lookup.type === 'object' && lookup.objectKind === 'conflict-evidence')
      .map(([providerId]) => providerId)).toEqual(['provider-a', 'provider-b']);
    expect(transport.stats()).toMatchObject({
      activeSlice: 0,
      retainedContinuationArtifacts: 0,
      retainedContinuationSidecarArtifacts: 0,
    });
  });

  it('resumes disputed-tombstone quarantine across slices without refetching retained artifacts', async () => {
    const fixture = await conflictReconcileFixture('tombstone');
    const candidates: AgentProfileReceiverAnyCandidateV1[] = [];
    const successfulLookups = new Map<string, number>();
    const fetchExact = vi.fn(async (
      providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (providerId === 'provider-a') {
        return Object.freeze({ outcome: 'not-found', wireBytes: 5 });
      }
      if (providerId === 'provider-b') {
        return Object.freeze({ outcome: 'remote-busy', wireBytes: 5 });
      }
      const artifact = await fixture.repository.resolve(lookup, signal);
      if (artifact === null) return Object.freeze({ outcome: 'not-found', wireBytes: 3 });
      const key = `${artifact.objectKind}:${artifact.objectDigest}`;
      successfulLookups.set(key, (successfulLookups.get(key) ?? 0) + 1);
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
      listProviderIds: () => ['provider-a', 'provider-b', 'provider-c'],
      fetchExact,
      controlAdmission: byteAdmission(),
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: receiver(fixture.repository, async (candidate) => {
        candidates.push(candidate);
        return {
          outcome: 'applied',
          stateRevision: '13',
          appliedStateDigest: `0x${'d'.repeat(64)}`,
        };
      }),
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      pendingRows: 1,
    });
    expect(reconciler.stats()).toMatchObject({
      retainedSidecarArtifacts: expect.any(Number),
      retainedClosureArtifacts: expect.any(Number),
    });
    expect(reconciler.stats().retainedSidecarArtifacts).toBeGreaterThan(0);
    const retained = transport.stats();
    expect(retained.retainedContinuationClosureArtifacts).toBeGreaterThan(0);
    expect(retained.retainedContinuationSidecarArtifacts).toBeGreaterThan(0);
    expect(retained.retainedContinuationArtifacts).toBeLessThan(
      retained.retainedContinuationClosureArtifacts
        + retained.retainedContinuationSidecarArtifacts,
    );
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'complete',
      processedRows: 1,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.operation).toBe('quarantine');
    expect(candidates[0]?.head).toEqual(fixture.current);
    expect([...successfulLookups.values()].every((count) => count === 1)).toBe(true);
    expect(transport.stats()).toMatchObject({
      retainedContinuationArtifacts: 0,
      retainedContinuationClosureArtifacts: 0,
      retainedContinuationSidecarArtifacts: 0,
    });
  });

  it('finishes retryable sidecar preflight before verifying the materialization bundle', async () => {
    const fixture = await conflictReconcileFixture('active');
    let pauseEvidence = true;
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (lookup.type === 'object'
          && lookup.objectKind === 'conflict-evidence'
          && pauseEvidence) {
        pauseEvidence = false;
        return Object.freeze({ outcome: 'remote-busy', wireBytes: 1 });
      }
      const artifact = await fixture.repository.resolve(lookup, signal);
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
    const verifyCurrentBundle = vi.fn(() => true);
    const candidates: AgentProfileReceiverAnyCandidateV1[] = [];
    const candidateReceiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: agentProfileArtifactSources(fixture.repository),
      verifyCurrentBundle,
      prepareCandidateApply: (candidate) => Object.freeze({
        existingMonotonicDeadlineMs: 10_000,
        monotonicNowMs: 1_000,
        apply: async () => {
          candidates.push(candidate);
          return Object.freeze({
            outcome: 'applied' as const,
            stateRevision: '14',
            appliedStateDigest: `0x${'e'.repeat(64)}`,
          });
        },
      }),
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: candidateReceiver,
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      pendingRows: 1,
    });
    expect(pauseEvidence).toBe(false);
    expect(verifyCurrentBundle).not.toHaveBeenCalled();

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'complete',
      processedRows: 1,
    });
    expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.operation).toBe('quarantine');
  });

  it('releases conflict continuation ownership when sidecar transport is aborted', async () => {
    const fixture = await conflictReconcileFixture('active');
    const controller = new AbortController();
    let sidecarRequested = false;
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (lookup.type === 'object' && lookup.objectKind === 'conflict-evidence') {
        sidecarRequested = true;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      const artifact = await fixture.repository.resolve(lookup, signal);
      if (artifact === null) return Object.freeze({ outcome: 'not-found', wireBytes: 3 });
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
    const consumeCandidate = vi.fn();
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: receiver(fixture.repository, consumeCandidate),
    });

    await reconciler.advance(new AbortController().signal);
    const advance = reconciler.advance(controller.signal);
    await vi.waitFor(() => expect(sidecarRequested).toBe(true));
    controller.abort(new Error('stop conflict sidecar'));
    await expect(advance).rejects.toThrow(/stop conflict sidecar/);
    expect(consumeCandidate).not.toHaveBeenCalled();
    expect(transport.stats()).toMatchObject({
      activeSlice: 0,
      retainedContinuationArtifacts: 0,
      retainedContinuationClosureArtifacts: 0,
      retainedContinuationSidecarArtifacts: 0,
    });
  });
});
