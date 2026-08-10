import { describe, expect, it, vi } from 'vitest';

import {
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  type AgentProfileTombstoneHeadObjectV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import type {
  SystemRecordApplyOutcomeV1,
  SystemRecordLaneSessionV1,
  SystemRecordLaneStateV1,
} from '@origintrail-official/dkg-storage';
import {
  createAgentProfileAdmittedSliceContextAuthorityV1,
} from '../src/system-records/admitted-slice-context-v1.js';
import {
  createAgentProfileMaterializerPrepareBridgeV1,
  type AgentProfileMaterializerCandidateIssueV1,
  type AgentProfileMaterializerLaneBindingV1,
} from '../src/system-records/agent-profile-materializer-bridge-v1-internal.js';
import type {
  SystemRecordArtifactRepositoryV1,
} from '../src/system-records/artifact-v1.js';
import {
  assertAuthenticAgentProfileReceiverCandidateV1,
  createAgentProfileCandidateReceiverV1,
  type AgentProfileReceiverAnyCandidateV1,
} from '../src/system-records/receiver-v1.js';
import { agentProfileArtifactSources } from './support/agent-profile-artifact-sources-v1-fixture.js';
import {
  envelopeArtifact,
  NETWORK,
  PRODUCER_FIXTURE_NOW_MS,
  signHeadEnvelope,
} from './support/agent-profile-producer-v1-fixture.js';
import {
  publishedReceiverFixture as publishedFixture,
} from './support/agent-profile-receiver-v1-fixture.js';
import {
  quarantineFixture,
} from './support/agent-profile-receiver-conflict-v1-fixture.js';

describe('agent-profile private materializer prepare bridge', () => {
  it('rejects a structural candidate before proof preparation', () => {
    const harness = materializerBridgeHarness();

    expect(() => harness.prepareCandidateApply(
      Object.freeze({ operation: 'active' }) as AgentProfileReceiverAnyCandidateV1,
      harness.context,
      new AbortController().signal,
    )).toThrow(/not produced by the verified receiver/);
    expect(harness.issueCandidate).not.toHaveBeenCalled();
    expect(harness.applyVerified).not.toHaveBeenCalled();
  });

  it('issues an active proof with the receiver-clamped monotonic deadline', async () => {
    const harness = materializerBridgeHarness();
    const fixture = await publishedFixture();
    const remainingWallMs = 2_000;
    const receiver = createReceiver(
      fixture.store,
      harness,
      () => Date.parse(fixture.envelope.object.validUntil) - remainingWallMs,
    );

    await expect(receiver.receiveActive(
      fixture.row,
      harness.context,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied' });

    const selectedDeadline = harness.monotonicNowMs + remainingWallMs;
    expect(harness.issueCandidate).toHaveBeenCalledTimes(1);
    expect(harness.issueCandidate.mock.calls[0]?.[0]).toMatchObject({
      operation: 'active',
      admittedDeadlineMs: selectedDeadline,
    });
    expect(harness.issues[0]?.admittedDeadlineMs).toBe(selectedDeadline);
  });

  it('keeps the original admitted deadline for a tombstone', async () => {
    const harness = materializerBridgeHarness();
    const fixture = await tombstoneFixture();
    const receiver = createReceiver(fixture.artifacts, harness);

    await expect(receiver.receiveCandidate(
      fixture.row,
      harness.context,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied' });

    expect(harness.issueCandidate).toHaveBeenCalledTimes(1);
    expect(harness.issueCandidate.mock.calls[0]?.[0]).toMatchObject({
      operation: 'tombstone',
      admittedDeadlineMs: harness.originalDeadlineMs,
    });
    expect(harness.issues[0]?.admittedDeadlineMs).toBe(harness.originalDeadlineMs);
  });

  it('maps a quarantine proof without shortening its terminal deadline', async () => {
    const harness = materializerBridgeHarness();
    const fixture = await quarantineFixture();
    const receiver = createReceiver(fixture.artifacts, harness);

    await expect(receiver.receiveCandidate(
      fixture.row,
      harness.context,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied' });

    expect(harness.issueCandidate).toHaveBeenCalledTimes(1);
    expect(harness.issueCandidate.mock.calls[0]?.[0]).toMatchObject({
      operation: 'quarantine',
      admittedDeadlineMs: harness.originalDeadlineMs,
      conflictEvidenceDigest: fixture.evidenceDigest,
      terminalTransitionConflict: false,
    });
    expect(harness.issues[0]?.admittedDeadlineMs).toBe(harness.originalDeadlineMs);
  });

  it.each([
    { label: 'tombstone' as const, makeFixture: tombstoneFixture },
    { label: 'quarantine' as const, makeFixture: quarantineFixture },
  ])('marks a $label candidate authentic at the shared candidate factory', async ({
    label,
    makeFixture,
  }) => {
    const harness = materializerBridgeHarness();
    const fixture = await makeFixture();
    const captured: unknown[] = [];
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: agentProfileArtifactSources(fixture.artifacts),
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: (candidate, admittedContext, signal) => {
        captured.push(candidate);
        return harness.prepareCandidateApply(candidate, admittedContext, signal);
      },
    });

    await expect(receiver.receiveCandidate(
      fixture.row,
      harness.context,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied' });

    // The marker is added in the shared candidate factory, not the active-only
    // facade, so terminal candidates must pass the authenticity guard.
    expect(captured).toHaveLength(1);
    expect(() => assertAuthenticAgentProfileReceiverCandidateV1(captured[0])).not.toThrow();
    expect((captured[0] as AgentProfileReceiverAnyCandidateV1).operation).toBe(label);
    expect(harness.issues[0]).toMatchObject({ operation: label });
  });

  it.each([
    {
      label: 'binding generation changes',
      change: (harness: MaterializerBridgeHarness) => harness.rotateChildGeneration(),
      expected: { outcome: 'deferred', reason: 'generation-changed' },
    },
    {
      label: 'session capability is lost',
      change: (harness: MaterializerBridgeHarness) => harness.setSessionState('shutdown'),
      expected: { outcome: 'capability-lost' },
    },
  ])('issues no proof when $label after preparation', async ({ change, expected }) => {
    const harness = materializerBridgeHarness();
    const fixture = await publishedFixture();
    const receiver = createReceiver(fixture.store, harness);
    const signal = new AbortController().signal;
    const prepared = await receiver.prepareActive(fixture.row, signal);
    const dispatch = await prepared.prepareDispatch(harness.context, signal);

    change(harness);

    await expect(dispatch.dispatch()).resolves.toEqual(expected);
    expect(harness.issueCandidate).not.toHaveBeenCalled();
    expect(harness.applyVerified).not.toHaveBeenCalled();
  });

  it('returns a typed deferral without issuing when direct dispatch lacks budget', async () => {
    const harness = materializerBridgeHarness({ remainingMs: 1_499 });
    const fixture = await publishedFixture();
    const receiver = createReceiver(fixture.store, harness);

    await expect(receiver.receiveActive(
      fixture.row,
      harness.context,
      new AbortController().signal,
    )).resolves.toEqual({
      outcome: 'deferred',
      reason: 'insufficient-apply-budget',
    });
    expect(harness.issueCandidate).not.toHaveBeenCalled();
    expect(harness.applyVerified).not.toHaveBeenCalled();
  });

  it('discards only a proof whose session transfer throws synchronously', async () => {
    const synchronous = materializerBridgeHarness({ failure: 'synchronous' });
    const fixture = await publishedFixture();
    await expect(createReceiver(fixture.store, synchronous).receiveActive(
      fixture.row,
      synchronous.context,
      new AbortController().signal,
    )).rejects.toThrow(/synchronous dispatch failure/);
    expect(synchronous.discardProof).toHaveBeenCalledTimes(1);

    const asynchronous = materializerBridgeHarness({ failure: 'asynchronous' });
    await expect(createReceiver(fixture.store, asynchronous).receiveActive(
      fixture.row,
      asynchronous.context,
      new AbortController().signal,
    )).rejects.toThrow(/asynchronous settlement failure/);
    expect(asynchronous.discardProof).not.toHaveBeenCalled();
  });
});

interface MaterializerBridgeHarness {
  readonly prepareCandidateApply: ReturnType<
    typeof createAgentProfileMaterializerPrepareBridgeV1
  >;
  readonly context: ReturnType<
    ReturnType<typeof createAgentProfileAdmittedSliceContextAuthorityV1>['mint']
  >;
  readonly monotonicNowMs: number;
  readonly originalDeadlineMs: number;
  readonly issueCandidate: ReturnType<typeof vi.fn>;
  readonly discardProof: ReturnType<typeof vi.fn>;
  readonly applyVerified: ReturnType<typeof vi.fn>;
  readonly issues: AgentProfileMaterializerCandidateIssueV1[];
  rotateChildGeneration(): void;
  setSessionState(state: SystemRecordLaneStateV1): void;
}

function materializerBridgeHarness(options: Readonly<{
  remainingMs?: number;
  failure?: 'synchronous' | 'asynchronous';
}> = {}): MaterializerBridgeHarness {
  const proofs = new WeakMap<object, AgentProfileMaterializerCandidateIssueV1>();
  const issueCandidate = vi.fn((input: AgentProfileMaterializerCandidateIssueV1) => {
    const proof = Object.freeze(Object.create(null) as object);
    proofs.set(proof, input);
    return proof;
  });
  const discardProof = vi.fn((proof: unknown) => {
    if (proof === null || typeof proof !== 'object' || !proofs.delete(proof)) {
      throw new Error('test bridge attempted to discard an unknown proof');
    }
  });
  const runtime = Object.freeze({
    issuer: Object.freeze({ issueCandidate }),
    consumer: Object.freeze({ discardProof }),
  });
  const sessionIdentity = Object.freeze(Object.create(null) as object);
  let binding: AgentProfileMaterializerLaneBindingV1 = Object.freeze({
    activationGeneration: '1',
    networkId: NETWORK,
    kind: 'agents',
    mode: 'authoritative',
    sessionIdentity,
    childGeneration: '2',
    materializationEpoch: '3',
  });
  const issues: AgentProfileMaterializerCandidateIssueV1[] = [];
  let sessionState: SystemRecordLaneStateV1 = 'enabled';
  const applyVerified = vi.fn((proof: unknown): Promise<SystemRecordApplyOutcomeV1> => {
    if (options.failure === 'synchronous') {
      throw new Error('synchronous dispatch failure');
    }
    if (proof === null || typeof proof !== 'object') {
      throw new Error('test session received a non-object proof');
    }
    const issue = proofs.get(proof);
    if (issue === undefined) throw new Error('test session received an unknown proof');
    proofs.delete(proof);
    issues.push(issue);
    if (options.failure === 'asynchronous') {
      return Promise.reject(new Error('asynchronous settlement failure'));
    }
    return Promise.resolve(Object.freeze({
      outcome: 'applied',
      stateRevision: '1',
      appliedStateDigest: `0x${'a'.repeat(64)}`,
    }));
  });
  const session: SystemRecordLaneSessionV1 = Object.freeze({
    get state() { return sessionState; },
    activationGeneration: binding.activationGeneration,
    applyVerified,
    close: async () => undefined,
  });
  const monotonicNowMs = 10_000;
  const originalDeadlineMs = monotonicNowMs + (options.remainingMs ?? 2_500);
  const authority = createAgentProfileAdmittedSliceContextAuthorityV1(
    () => monotonicNowMs,
  );
  const context = authority.mint(originalDeadlineMs);
  const prepareCandidateApply = createAgentProfileMaterializerPrepareBridgeV1({
    runtime,
    session,
    inspectAdmittedContext: authority.inspect,
    resolveBinding: () => binding,
  });
  return {
    prepareCandidateApply,
    context,
    monotonicNowMs,
    originalDeadlineMs,
    issueCandidate,
    discardProof,
    applyVerified,
    issues,
    rotateChildGeneration() {
      binding = Object.freeze({
        ...binding,
        childGeneration: String(BigInt(binding.childGeneration) + 1n),
      });
    },
    setSessionState(state) {
      sessionState = state;
    },
  };
}

function createReceiver(
  artifacts: SystemRecordArtifactRepositoryV1,
  harness: MaterializerBridgeHarness,
  nowMs: () => number = () => PRODUCER_FIXTURE_NOW_MS,
) {
  return createAgentProfileCandidateReceiverV1({
    networkId: NETWORK,
    artifacts: agentProfileArtifactSources(artifacts),
    nowMs,
    verifyCurrentBundle: () => true,
    prepareCandidateApply: harness.prepareCandidateApply,
  });
}

async function tombstoneFixture() {
  const fixture = await publishedFixture(true);
  const predecessor = fixture.envelope.object;
  const tombstone: AgentProfileTombstoneHeadObjectV1 = Object.freeze({
    objectType: 'agent-profile-head',
    kind: 'agents',
    state: 'tombstone',
    networkId: predecessor.networkId,
    peerId: predecessor.peerId,
    peerPublicKey: predecessor.peerPublicKey,
    authoritySequence: predecessor.authoritySequence,
    version: String(BigInt(predecessor.version) + 1n),
    ...(predecessor.acceptedTransitionDigest === undefined ? {} : {
      acceptedTransitionDigest: predecessor.acceptedTransitionDigest,
    }),
    previousHeadDigest: fixture.envelope.objectDigest,
    evmIssuer: predecessor.evmIssuer,
    rootSubject: predecessor.rootSubject,
    projectionSchemaDigest: predecessor.projectionSchemaDigest,
    issuedAt: '2026-08-07T12:10:00Z',
    ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
    ownedSubjectCount: '0',
    projectionBytes: '0',
    projectionQuads: '0',
  });
  const envelope = await signHeadEnvelope(
    tombstone,
    fixture.peerSigner,
    fixture.evmSigner,
  );
  const artifact = envelopeArtifact('agent-profile-head', envelope);
  const artifacts: SystemRecordArtifactRepositoryV1 = Object.freeze({
    async resolve(lookup, signal) {
      signal.throwIfAborted();
      if (lookup.type === 'object'
          && lookup.objectKind === artifact.objectKind
          && lookup.objectDigest === artifact.objectDigest) return artifact;
      return fixture.store.resolve(lookup, signal);
    },
  });
  const row: SystemRecordInventoryRowV1 = Object.freeze({
    stableKeyHash: fixture.row.stableKeyHash,
    peerId: fixture.row.peerId,
    authoritySequence: tombstone.authoritySequence,
    version: tombstone.version,
    headDigest: envelope.objectDigest,
    tombstone: true,
    quarantined: false,
  });
  return Object.freeze({ row, artifacts });
}
