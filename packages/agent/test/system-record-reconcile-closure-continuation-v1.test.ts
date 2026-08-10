import { describe, expect, it, vi } from 'vitest';

import { decodeOpaqueKaBundleV1 } from '@origintrail-official/dkg-core';
import {
  SYSTEM_RECORD_MAX_CLOCK_SKEW_MS,
  SYSTEM_RECORD_MAX_SLICE_REQUESTS,
  type AgentProfileHeadObjectV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { parseNQuads } from '../src/dkg-agent-utils.js';
import type { AgentProfileAdmittedSliceContextV1 } from '../src/system-records/admitted-slice-context-v1.js';
import {
  createAgentProfileReceiverV1,
  type AgentProfileContinuationReceiverV1,
  type AgentProfileReceiverCandidateV1,
} from '../src/system-records/receiver-v1.js';
import {
  createAgentProfileReconcilerV1,
  type AgentProfileReconcileAdmissionV1,
} from '../src/system-records/reconcile-v1.js';
import { createAgentProfileReconcileTransportV1 } from '../src/system-records/reconcile-transport-v1.js';
import type {
  SystemRecordExactArtifactLookupV1,
  SystemRecordExactFetchResultV1,
} from '../src/system-records/requester-v1.js';
import {
  maximumAuthorityClosureFixtureV1,
} from './support/agent-profile-reconcile-closure-v1-fixture.js';
import {
  NETWORK,
  PRODUCER_FIXTURE_NOW_MS,
} from './support/agent-profile-producer-v1-fixture.js';

describe('agent-profile closure continuation V1', () => {
  it('completes a 31-artifact authority closure over three bounded physical slices', async () => {
    const fixture = await maximumAuthorityClosureFixtureV1();
    expect(fixture.artifacts.size).toBe(31);
    const directCandidates: unknown[] = [];
    const directReceiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.repository,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope: () => true,
      verifyCurrentBundle: (_head, bundleBytes) => {
        verifiedFixtureBundle(bundleBytes);
        return true;
      },
      prepareCandidateApply: candidateApply(async (candidate) => {
        directCandidates.push(candidate);
        return appliedOutcome('11');
      }),
    });
    await directReceiver.receiveActive(
      fixture.row,
      Object.freeze(Object.create(null)) as AgentProfileAdmittedSliceContextV1,
      new AbortController().signal,
    );

    const releaseByKey = new Map<string, ReturnType<typeof vi.fn>>();
    const fetchCounts = new Map<string, number>();
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      const artifact = await fixture.repository.resolve(lookup, signal);
      if (artifact === null) return Object.freeze({ outcome: 'not-found', wireBytes: 1 });
      const key = `${artifact.objectKind}:${artifact.objectDigest}`;
      fetchCounts.set(key, (fetchCounts.get(key) ?? 0) + 1);
      const release = vi.fn();
      releaseByKey.set(key, release);
      return Object.freeze({
        outcome: 'ok',
        lease: Object.freeze({
          artifact,
          wireBytes: 128 + artifact.canonicalBytes.byteLength,
          release,
        }),
      });
    });
    const control = trackingByteAdmission();
    const transport = createAgentProfileReconcileTransportV1({
      networkId: NETWORK,
      listProviderIds: () => ['provider-a'],
      fetchExact,
      controlAdmission: control,
    });
    const verifyAuthorityEnvelope = vi.fn(() => true);
    const verifyCurrentBundle = vi.fn(
      (_head: AgentProfileHeadObjectV1, bundleBytes: Uint8Array) => {
        verifiedFixtureBundle(bundleBytes);
        return true;
      },
    );
    const transportedCandidates: unknown[] = [];
    const transportedReceiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.repository,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope,
      verifyCurrentBundle,
      prepareCandidateApply: candidateApply(async (candidate) => {
        transportedCandidates.push(candidate);
        return appliedOutcome('22');
      }),
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: transportedReceiver,
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      inventoryRequests: 1,
    });
    expect(transport.stats().retainedContinuationControlBytes).toBe(0);
    expect(control.activeReservations()).toBe(0);
    const cumulativeClosureRequests: number[] = [];
    let finalResult;
    for (let sliceIndex = 0; sliceIndex < 3; sliceIndex += 1) {
      const before = closureRequestCount(fetchExact.mock.calls);
      finalResult = await reconciler.advance(new AbortController().signal);
      const after = closureRequestCount(fetchExact.mock.calls);
      expect(after - before).toBeLessThanOrEqual(SYSTEM_RECORD_MAX_SLICE_REQUESTS);
      cumulativeClosureRequests.push(after);
      if (sliceIndex < 2) {
        expect(finalResult).toMatchObject({ status: 'paused', phase: 'records' });
        expect(reconciler.stats()).toMatchObject({
          retainedClosureArtifacts: (sliceIndex + 1) * SYSTEM_RECORD_MAX_SLICE_REQUESTS,
        });
        expect(reconciler.stats().retainedClosureBytes).toBeGreaterThan(0);
      }
    }

    expect(cumulativeClosureRequests).toEqual([12, 24, 31]);
    expect(finalResult).toMatchObject({ status: 'complete', processedRows: 1 });
    expect([...fetchCounts.values()].every((count) => count === 1)).toBe(true);
    expect(fetchCounts.size).toBe(32); // 31 closure artifacts plus one inventory leaf.
    expect(verifyAuthorityEnvelope.mock.calls.length).toBeGreaterThan(29);
    expect(verifyCurrentBundle).toHaveBeenCalled();
    expect(transportedCandidates).toEqual(directCandidates);
    expect(reconciler.stats()).toMatchObject({
      retainedClosureArtifacts: 0,
      retainedClosureBytes: 0,
    });
    expect(transport.stats()).toMatchObject({
      retainedContinuationArtifacts: 0,
      retainedContinuationBytes: 0,
      retainedContinuationControlBytes: 0,
    });
    expect([...releaseByKey.values()].every((release) => release.mock.calls.length === 1))
      .toBe(true);
    expect(control.activeReservations()).toBe(0);
    expect(control.activeBytes()).toBe(0);
  });

  it('resamples verification time when an expired-prior continuation resumes', async () => {
    const fixture = await maximumAuthorityClosureFixtureV1({
      expiredPriorTransitionSequence: 13,
    });
    if (fixture.expiredPriorTransitionDigest === undefined
        || fixture.expiredPriorValidUntil === undefined) {
      throw new Error('fixture did not expose its expired-prior transition');
    }
    const validAtMs = Date.parse(fixture.expiredPriorValidUntil)
      + SYSTEM_RECORD_MAX_CLOCK_SKEW_MS;
    let now = validAtMs - 1;
    let pauseBeforeTransition = true;
    const fetchExact = vi.fn(async (
      _providerId: string,
      lookup: SystemRecordExactArtifactLookupV1,
      signal: AbortSignal,
    ): Promise<SystemRecordExactFetchResultV1> => {
      if (lookup.objectDigest === fixture.expiredPriorTransitionDigest
          && pauseBeforeTransition) {
        pauseBeforeTransition = false;
        return Object.freeze({ outcome: 'remote-busy', wireBytes: 1 });
      }
      const artifact = await fixture.repository.resolve(lookup, signal);
      if (artifact === null) return Object.freeze({ outcome: 'not-found', wireBytes: 1 });
      return Object.freeze({
        outcome: 'ok',
        lease: Object.freeze({
          artifact,
          wireBytes: 128 + artifact.canonicalBytes.byteLength,
          release: vi.fn(),
        }),
      });
    });
    const transport = createAgentProfileReconcileTransportV1({
      networkId: NETWORK,
      listProviderIds: () => ['provider-a'],
      fetchExact,
      controlAdmission: trackingByteAdmission(),
    });
    const receiverNowMs = vi.fn(() => now);
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.repository,
      nowMs: receiverNowMs,
      verifyAuthorityEnvelope: () => true,
      verifyCurrentBundle: (_head, bundleBytes) => {
        verifiedFixtureBundle(bundleBytes);
        return true;
      },
      prepareCandidateApply: candidateApply(async () => appliedOutcome('33')),
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver,
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
    });
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      pendingRows: 1,
    });
    expect(pauseBeforeTransition).toBe(false);
    expect(reconciler.stats().retainedClosureArtifacts).toBeGreaterThan(0);

    now = validAtMs;
    let result;
    for (let slice = 0; slice < 4; slice += 1) {
      result = await reconciler.advance(new AbortController().signal);
      if (result.status === 'complete') break;
      expect(result).toMatchObject({ status: 'paused', phase: 'records' });
    }
    expect(result).toMatchObject({ status: 'complete', processedRows: 1 });
    expect(receiverNowMs.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(reconciler.stats()).toMatchObject({
      retainedClosureArtifacts: 0,
      retainedClosureBytes: 0,
    });
  });

  it('rechecks injected authority verification when preparation resumes', async () => {
    const fixture = await maximumAuthorityClosureFixtureV1();
    let authorityAllowed = true;
    let pauseAfterAuthority = true;
    const verifyAuthorityEnvelope = vi.fn(() => authorityAllowed);
    const consumeCandidate = vi.fn(async () => appliedOutcome('44'));
    const transport = createAgentProfileReconcileTransportV1({
      networkId: NETWORK,
      listProviderIds: () => ['provider-a'],
      fetchExact: async (_providerId, lookup, signal) => {
        if (verifyAuthorityEnvelope.mock.calls.length > 0 && pauseAfterAuthority) {
          pauseAfterAuthority = false;
          return Object.freeze({ outcome: 'remote-busy' as const, wireBytes: 1 });
        }
        const artifact = await fixture.repository.resolve(lookup, signal);
        if (artifact === null) {
          return Object.freeze({ outcome: 'not-found' as const, wireBytes: 1 });
        }
        return Object.freeze({
          outcome: 'ok' as const,
          lease: Object.freeze({
            artifact,
            wireBytes: 128 + artifact.canonicalBytes.byteLength,
            release: vi.fn(),
          }),
        });
      },
      controlAdmission: trackingByteAdmission(),
    });
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.repository,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope,
      verifyCurrentBundle: (_head, bundleBytes) => {
        verifiedFixtureBundle(bundleBytes);
        return true;
      },
      prepareCandidateApply: candidateApply(consumeCandidate),
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver,
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
      pendingRows: 1,
    });
    const callsBeforeResume = verifyAuthorityEnvelope.mock.calls.length;
    expect(callsBeforeResume).toBeGreaterThan(0);
    authorityAllowed = false;

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'records',
      reason: 'receiver-verification-failed',
      pendingRows: 1,
    });
    expect(verifyAuthorityEnvelope.mock.calls.length).toBeGreaterThan(callsBeforeResume);
    expect(consumeCandidate).not.toHaveBeenCalled();
    expect(reconciler.stats()).toMatchObject({
      retainedClosureArtifacts: 0,
      retainedClosureBytes: 0,
    });
  });

  it('rechecks publication verification when preparation resumes', async () => {
    const fixture = await maximumAuthorityClosureFixtureV1();
    let bundleAllowed = true;
    let pauseAfterBundle = true;
    const verifyCurrentBundle = vi.fn(
      (_head: AgentProfileHeadObjectV1, bundleBytes: Uint8Array) => {
        if (!bundleAllowed) throw new Error('publication verification was revoked');
        verifiedFixtureBundle(bundleBytes);
        return true;
      },
    );
    const consumeCandidate = vi.fn(async () => appliedOutcome('55'));
    const transport = createAgentProfileReconcileTransportV1({
      networkId: NETWORK,
      listProviderIds: () => ['provider-a'],
      fetchExact: async (_providerId, lookup, signal) => {
        if (verifyCurrentBundle.mock.calls.length > 0 && pauseAfterBundle) {
          pauseAfterBundle = false;
          return Object.freeze({ outcome: 'remote-busy' as const, wireBytes: 1 });
        }
        const artifact = await fixture.repository.resolve(lookup, signal);
        if (artifact === null) {
          return Object.freeze({ outcome: 'not-found' as const, wireBytes: 1 });
        }
        return Object.freeze({
          outcome: 'ok' as const,
          lease: Object.freeze({
            artifact,
            wireBytes: 128 + artifact.canonicalBytes.byteLength,
            release: vi.fn(),
          }),
        });
      },
      controlAdmission: trackingByteAdmission(),
    });
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.repository,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope: () => true,
      verifyCurrentBundle,
      prepareCandidateApply: candidateApply(consumeCandidate),
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver,
    });

    await reconciler.advance(new AbortController().signal);
    let result;
    for (let slice = 0; slice < 4; slice += 1) {
      result = await reconciler.advance(new AbortController().signal);
      if (!pauseAfterBundle) break;
      expect(result).toMatchObject({ status: 'paused', phase: 'records' });
    }
    expect(result).toMatchObject({ status: 'paused', phase: 'records', pendingRows: 1 });
    const callsBeforeResume = verifyCurrentBundle.mock.calls.length;
    expect(callsBeforeResume).toBeGreaterThan(0);
    bundleAllowed = false;

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'records',
      reason: 'receiver-verification-failed',
      pendingRows: 1,
    });
    expect(verifyCurrentBundle.mock.calls.length).toBeGreaterThan(callsBeforeResume);
    expect(consumeCandidate).not.toHaveBeenCalled();
    expect(reconciler.stats()).toMatchObject({
      retainedClosureArtifacts: 0,
      retainedClosureBytes: 0,
    });
  });

  it('releases retained closure ownership when the caller aborts between slices', async () => {
    const fixture = await maximumAuthorityClosureFixtureV1();
    const releases: ReturnType<typeof vi.fn>[] = [];
    const control = trackingByteAdmission();
    const transport = createAgentProfileReconcileTransportV1({
      networkId: NETWORK,
      listProviderIds: () => ['provider-a'],
      fetchExact: async (_providerId, lookup, signal) => {
        const resolved = lookup.type === 'inventory-object'
          ? await fixture.repository.resolve(lookup, signal)
          : Object.freeze({
            objectKind: lookup.objectKind,
            objectDigest: lookup.objectDigest,
            canonicalBytes: Uint8Array.of(1),
          });
        if (resolved === null) return Object.freeze({ outcome: 'not-found' as const, wireBytes: 1 });
        const release = vi.fn();
        releases.push(release);
        return Object.freeze({
          outcome: 'ok' as const,
          lease: Object.freeze({
            artifact: resolved,
            wireBytes: 128 + resolved.canonicalBytes.byteLength,
            release,
          }),
        });
      },
      controlAdmission: control,
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      transport,
      receiver: syntheticThirteenArtifactReceiver(),
    });

    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
    });
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'paused',
      phase: 'records',
    });
    expect(reconciler.stats()).toMatchObject({ retainedClosureArtifacts: 12 });
    const controller = new AbortController();
    controller.abort(new Error('caller stopped continuation'));

    await expect(reconciler.advance(controller.signal)).rejects.toThrow('caller stopped');
    expect(reconciler.stats()).toMatchObject({
      retainedClosureArtifacts: 0,
      retainedClosureBytes: 0,
    });
    expect(releases).toHaveLength(13); // one inventory lease plus twelve retained artifacts.
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(control.activeReservations()).toBe(0);
    expect(control.activeBytes()).toBe(0);
  });
});

function candidateApply(
  consume: (candidate: AgentProfileReceiverCandidateV1) =>
    ReturnType<typeof appliedOutcome> | Promise<ReturnType<typeof appliedOutcome>>,
) {
  return (candidate: AgentProfileReceiverCandidateV1) => Object.freeze({
    existingMonotonicDeadlineMs: 10_000,
    monotonicNowMs: 1_000,
    apply: () => consume(candidate),
  });
}

function verifiedFixtureBundle(bundleBytes: Uint8Array) {
  const { projectionBytes } = decodeOpaqueKaBundleV1(bundleBytes);
  return Object.freeze({
    canonicalProjectionBytes: Uint8Array.from(projectionBytes),
    projectionQuads: Object.freeze(parseNQuads(new TextDecoder().decode(projectionBytes))),
  });
}

function appliedOutcome(byte: string) {
  return Object.freeze({
    outcome: 'applied' as const,
    stateRevision: '1',
    appliedStateDigest: `0x${byte.repeat(32)}`,
  });
}

function syntheticThirteenArtifactReceiver(): AgentProfileContinuationReceiverV1 {
  return Object.freeze({
    openPreparation() {
      return Object.freeze({
        async prepare(source, signal) {
          for (let index = 0; index <= SYSTEM_RECORD_MAX_SLICE_REQUESTS; index += 1) {
            await source.resolve(Object.freeze({
              type: 'object' as const,
              objectKind: 'agent-profile-head' as const,
              objectDigest: `0x${index.toString(16).padStart(64, '0')}` as Digest32V1,
            }), signal);
          }
          return Object.freeze({
            async prepareDispatch() {
              return Object.freeze({
                dispatch: async () => appliedOutcome('33'),
              });
            },
          });
        },
        release: () => undefined,
      });
    },
    prepareActive: async () => { throw new Error('test uses stateful preparation'); },
    receiveActive: async () => { throw new Error('test uses stateful preparation'); },
  });
}

function closureRequestCount(calls: readonly unknown[][]): number {
  return calls.filter((call) =>
    (call[1] as SystemRecordExactArtifactLookupV1 | undefined)?.type === 'object',
  ).length;
}

function trackingByteAdmission() {
  let activeBytes = 0;
  let activeReservations = 0;
  return Object.freeze({
    tryReserve(bytes: number) {
      activeBytes += bytes;
      activeReservations += 1;
      let live = true;
      return Object.freeze({
        release() {
          if (!live) return;
          live = false;
          activeBytes -= bytes;
          activeReservations -= 1;
        },
      });
    },
    activeBytes: () => activeBytes,
    activeReservations: () => activeReservations,
  });
}

function admissionGate(): AgentProfileReconcileAdmissionV1 {
  let held = false;
  const deadlines = new WeakMap<object, number>();
  return Object.freeze({
    tryAcquire() {
      if (held) return null;
      held = true;
      const context = Object.freeze(Object.create(null)) as AgentProfileAdmittedSliceContextV1;
      deadlines.set(context, PRODUCER_FIXTURE_NOW_MS + 3_000);
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
      const admittedDeadlineMs = deadlines.get(context);
      if (admittedDeadlineMs === undefined) throw new Error('test admitted context is invalid');
      return Object.freeze({ nowMs: PRODUCER_FIXTURE_NOW_MS, admittedDeadlineMs });
    },
  });
}
