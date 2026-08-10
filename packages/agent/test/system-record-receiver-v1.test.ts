import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import { decodeOpaqueKaBundleV1 } from '@origintrail-official/dkg-core';

import {
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeAgentProfileConflictEvidenceV1,
  computeAgentProfileConflictEvidenceDigestV1,
  deriveAgentProfileOwnedSubjectV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  type AgentProfileConflictEvidenceV1,
  type AgentProfileHeadObjectV1,
  type Digest32V1,
  type OwnedSubjectTableObjectV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  createEvmPersonalMessageSignerV1,
} from '../src/evm-message-signer-v1.js';
import {
  createAgentProfileCandidateReceiverV1 as createReceiverWithArtifactSources,
  createAgentProfileReceiverV1,
  type CreateAgentProfileCandidateReceiverOptionsV1,
  type AgentProfileCandidateContinuationReceiverV1,
  type AgentProfileReceiverAnyCandidateV1,
} from '../src/system-records/receiver-v1.js';
import type {
  SystemRecordArtifactRepositoryV1,
} from '../src/system-records/artifact-v1.js';
import {
  createAgentProfileAdmittedSliceContextAuthorityV1,
  type AgentProfileAdmittedSliceContextV1,
} from '../src/system-records/admitted-slice-context-v1.js';
import {
  envelopeArtifact,
  NETWORK,
  OTHER_PRIVATE_KEY,
  PRODUCER_FIXTURE_NOW_MS,
  signHeadEnvelope,
} from './support/agent-profile-producer-v1-fixture.js';
import {
  compareReceiverQuad as compareQuad,
  compareReceiverUtf8 as compareUtf8,
  DEFAULT_MONOTONIC_APPLY_TIMING,
  preparedFixtureApply,
  publishedReceiverFixture as publishedFixture,
  publishedReceiverFixtureWithHeadPatch,
  publishedReceiverFixtureWithProjectionBytes,
  RECEIVER_CANONICAL_PROJECTION_FAILURE_CASES,
  RECEIVER_HEAD_COUNT_MISMATCH_CASES,
  RECEIVER_PROFILE_PROJECTION_FAILURE_CASES,
  rotatedPublishedReceiverFixture as rotatedPublishedFixture,
} from './support/agent-profile-receiver-v1-fixture.js';
import { agentProfileArtifactSources } from './support/agent-profile-artifact-sources-v1-fixture.js';
import {
  activeTombstoneConflictFixture,
  overlayRepository,
  quarantineFixture,
  tombstoneFixture,
  transitionQuarantineFixture,
} from './support/agent-profile-receiver-conflict-v1-fixture.js';

const ADMITTED_CONTEXT = createAgentProfileAdmittedSliceContextAuthorityV1(
  () => 0,
).mint(3_000);

function createAgentProfileCandidateReceiverV1(
  options: Omit<CreateAgentProfileCandidateReceiverOptionsV1, 'artifacts'> & Readonly<{
    artifacts: SystemRecordArtifactRepositoryV1;
  }>,
): AgentProfileCandidateContinuationReceiverV1 {
  const { artifacts, ...receiverOptions } = options;
  return createReceiverWithArtifactSources({
    ...receiverOptions,
    artifacts: agentProfileArtifactSources(artifacts),
  });
}

async function receivePrepared(
  receiver: AgentProfileCandidateContinuationReceiverV1,
  row: SystemRecordInventoryRowV1,
  artifacts: SystemRecordArtifactRepositoryV1,
  signal: AbortSignal,
) {
  const preparation = receiver.openPreparation(row);
  try {
    const prepared = await preparation.prepare(agentProfileArtifactSources(artifacts), signal);
    signal.throwIfAborted();
    const dispatch = await prepared.prepareDispatch(ADMITTED_CONTEXT, signal);
    signal.throwIfAborted();
    return dispatch.dispatch();
  } finally {
    preparation.release();
  }
}

describe('agent-profile system-record receiver', () => {
  it('verifies the exact closure and submits one immutable active candidate', async () => {
    const fixture = await publishedFixture();
    const signal = new AbortController().signal;
    const bundleArtifact = await fixture.store.resolve({
      type: 'object',
      objectKind: 'profile-bundle',
      objectDigest: fixture.envelope.object.bundleDigest,
    }, signal);
    if (bundleArtifact === null) throw new Error('fixture bundle was not retained');
    const verifyCurrentBundle = vi.fn((head, bundleBytes: Uint8Array, receivedSignal) => {
      expect(head).toEqual(fixture.envelope.object);
      expect(bundleBytes).toEqual(bundleArtifact.canonicalBytes);
      expect(receivedSignal).toBe(signal);
      return true;
    });
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverAnyCandidateV1,
      _admittedContext: AgentProfileAdmittedSliceContextV1,
      _signal: AbortSignal,
    ) => preparedFixtureApply('1', 'a'));
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, ADMITTED_CONTEXT, signal))
      .resolves.toMatchObject({ outcome: 'applied' });
    expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
    const candidate = prepareCandidateApply.mock.calls[0]![0];
    expect(candidate.head).toEqual(fixture.envelope.object);
    expect(candidate.envelope).toEqual(fixture.envelope);
    expect([...candidate.projectionQuads].sort(compareQuad))
      .toEqual([...fixture.prepared.projectionQuads].sort(compareQuad));
    expect(candidate.ownedSubjectTable).toContain(fixture.prepared.rootEntity);
    expect(candidate.canonicalProjectionBytes).toEqual(
      decodeOpaqueKaBundleV1(bundleArtifact.canonicalBytes).projectionBytes,
    );
    expect(candidate).not.toHaveProperty('signal');
    expect(prepareCandidateApply.mock.calls[0]![1]).toBe(ADMITTED_CONTEXT);
    expect(prepareCandidateApply.mock.calls[0]![2]).toBe(signal);
    expect(prepareCandidateApply.mock.calls[0]).toHaveLength(3);
  });

  it('accepts a structural legacy repository with a reserved extra field', async () => {
    const fixture = await publishedFixture();
    const signal = new AbortController().signal;
    const resolve = vi.fn(fixture.store.resolve.bind(fixture.store));
    const legacyRepository = Object.freeze({
      resolve,
      closureArtifacts: Object.freeze({ kind: 'legacy-cache' }),
    });
    const verifyCurrentBundle = vi.fn(() => true);
    const prepareCandidateApply = vi.fn(() => preparedFixtureApply('1', 'a'));
    const receiver = createReceiverWithArtifactSources({
      networkId: NETWORK,
      artifacts: legacyRepository,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, ADMITTED_CONTEXT, signal))
      .resolves.toMatchObject({ outcome: 'applied' });

    const preparation = receiver.openPreparation(fixture.row);
    try {
      const prepared = await preparation.prepare(legacyRepository, signal);
      const dispatch = await prepared.prepareDispatch(ADMITTED_CONTEXT, signal);
      await expect(dispatch.dispatch()).resolves.toMatchObject({ outcome: 'applied' });
    } finally {
      preparation.release();
    }

    expect(verifyCurrentBundle).toHaveBeenCalledTimes(2);
    expect(prepareCandidateApply).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalled();
  });

  it('rejects malformed split artifact sources instead of treating them as legacy', async () => {
    const fixture = await publishedFixture();
    const common = {
      networkId: NETWORK,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: () => preparedFixtureApply('1', 'a'),
    };
    expect(() => createReceiverWithArtifactSources({
      ...common,
      artifacts: { closureArtifacts: fixture.store } as never,
    })).toThrow(/must provide both repositories/);

    const receiver = createReceiverWithArtifactSources({ ...common, artifacts: fixture.store });
    const preparation = receiver.openPreparation(fixture.row);
    try {
      expect(() => preparation.prepare(
        { securitySidecarArtifacts: fixture.store } as never,
        new AbortController().signal,
      )).toThrow(/must provide both repositories/);
    } finally {
      preparation.release();
    }
  });

  it.each([
    ['tombstone', tombstoneFixture],
    ['quarantined', quarantineFixture],
  ] as const)(
    'keeps the active-only compatibility API closed to %s inventory rows',
    async (_label, createFixture) => {
      const fixture = await createFixture();
      const resolve = vi.fn(fixture.artifacts.resolve.bind(fixture.artifacts));
      const prepareCandidateApply = vi.fn();
      const receiver = createAgentProfileReceiverV1({
        networkId: NETWORK,
        artifacts: { resolve },
        nowMs: () => PRODUCER_FIXTURE_NOW_MS,
        verifyCurrentBundle: () => true,
        prepareCandidateApply,
      });
      const signal = new AbortController().signal;

      expect('prepareCandidate' in receiver).toBe(false);
      expect('receiveCandidate' in receiver).toBe(false);
      expect(() => receiver.openPreparation(fixture.row))
        .toThrow(/active-only.*non-active/);
      await expect(receiver.prepareActive(fixture.row, signal))
        .rejects.toThrow(/active-only.*non-active/);
      await expect(receiver.receiveActive(fixture.row, ADMITTED_CONTEXT, signal))
        .rejects.toThrow(/active-only.*non-active/);
      expect(resolve).not.toHaveBeenCalled();
      expect(prepareCandidateApply).not.toHaveBeenCalled();
    },
  );

  it('does not invoke active bundle verification for a non-active current head', async () => {
    const fixture = await publishedFixture();
    const active = fixture.envelope.object;
    const tombstone = {
      objectType: 'agent-profile-head',
      kind: 'agents',
      state: 'tombstone',
      networkId: active.networkId,
      peerId: active.peerId,
      peerPublicKey: active.peerPublicKey,
      authoritySequence: active.authoritySequence,
      version: '1',
      previousHeadDigest: fixture.envelope.objectDigest,
      evmIssuer: active.evmIssuer,
      rootSubject: active.rootSubject,
      projectionSchemaDigest: active.projectionSchemaDigest,
      issuedAt: '2026-08-07T12:10:00Z',
      ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
      ownedSubjectCount: '0',
      projectionBytes: '0',
      projectionQuads: '0',
    } as AgentProfileHeadObjectV1;
    const tombstoneEnvelope = await signHeadEnvelope(
      tombstone,
      fixture.peerSigner,
      fixture.evmSigner,
    );
    const tombstoneArtifact = envelopeArtifact('agent-profile-head', tombstoneEnvelope);
    const resolve = vi.fn(async (lookup, signal) => lookup.type === 'object'
      && lookup.objectKind === 'agent-profile-head'
      && lookup.objectDigest === tombstoneEnvelope.objectDigest
      ? tombstoneArtifact
      : fixture.store.resolve(lookup, signal));
    const verifyCurrentBundle = vi.fn();
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(Object.freeze({
      ...fixture.row,
      version: tombstone.version,
      headDigest: tombstoneEnvelope.objectDigest,
    }), ADMITTED_CONTEXT, new AbortController().signal))
      .rejects.toThrow(/inventory row does not bind/);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(verifyCurrentBundle).not.toHaveBeenCalled();
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('rejects an expired active head before bundle verification or materialization', async () => {
    const fixture = await publishedFixture();
    const expiredHead = Object.freeze({
      ...fixture.envelope.object,
      validUntil: '2026-08-07T12:20:00Z',
    }) as AgentProfileHeadObjectV1;
    const expiredEnvelope = await signHeadEnvelope(
      expiredHead,
      fixture.peerSigner,
      fixture.evmSigner,
    );
    const expiredArtifact = envelopeArtifact('agent-profile-head', expiredEnvelope);
    const resolve = vi.fn(async (lookup, signal) => lookup.type === 'object'
      && lookup.objectKind === 'agent-profile-head'
      && lookup.objectDigest === expiredEnvelope.objectDigest
      ? expiredArtifact
      : fixture.store.resolve(lookup, signal));
    const verifyCurrentBundle = vi.fn();
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(Object.freeze({
      ...fixture.row,
      headDigest: expiredEnvelope.objectDigest,
    }), ADMITTED_CONTEXT, new AbortController().signal))
      .rejects.toThrow(/expired agent-profile head/);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(verifyCurrentBundle).not.toHaveBeenCalled();
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('hands every derived owned subject to the materializer candidate', async () => {
    const fixture = await publishedFixture(true);
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverAnyCandidateV1,
      _admittedContext: AgentProfileAdmittedSliceContextV1,
      _signal: AbortSignal,
    ) => preparedFixtureApply('1', 'a'));
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied' });
    const candidate = prepareCandidateApply.mock.calls[0]![0];
    const expectedOwnedSubjects = [...new Set(
      fixture.prepared.projectionQuads.map(({ subject }) => subject),
    )].sort(compareUtf8);
    expect(expectedOwnedSubjects.length).toBeGreaterThan(1);
    expect(candidate.ownedSubjectTable).toEqual(expectedOwnedSubjects);
    expect(candidate.head.ownedSubjectCount).toBe(String(expectedOwnedSubjects.length));
    expect(candidate.envelope.object.state).toBe('active');
  });

  it('traverses post-transition authority history and hands off its verified lineage', async () => {
    const fixture = await rotatedPublishedFixture();
    const verifyAuthorityEnvelope = vi.fn(() => true);
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverAnyCandidateV1,
      _admittedContext: AgentProfileAdmittedSliceContextV1,
      _signal: AbortSignal,
    ) => preparedFixtureApply('5', '9'));
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve: fixture.resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    ))
      .resolves.toMatchObject({ outcome: 'applied' });
    const resolvedKinds = fixture.resolve.mock.calls
      .map(([lookup]) => lookup.type === 'object' ? lookup.objectKind : lookup.type);
    expect(resolvedKinds).toEqual(expect.arrayContaining([
      'agent-profile-head',
      'profile-bundle',
      'authority-transition',
      'owned-subject-table',
    ]));
    expect(verifyAuthorityEnvelope.mock.calls.map(([candidate]) => candidate.object.objectType))
      .toEqual([
        'agent-profile-head',
        'authority-transition',
        'agent-profile-head',
      ]);
    const candidate = prepareCandidateApply.mock.calls[0]![0];
    expect(candidate.verifiedAuthoritySummary).toMatchObject({
      candidateHeadDigest: fixture.envelope.objectDigest,
      transitionLineage: [{
        priorAuthoritySequence: '0',
        nextAuthoritySequence: '1',
        transitionDigest: fixture.transitionEnvelope.objectDigest,
      }],
      historicalRoots: [fixture.prior.envelope.object.rootSubject],
      lastAuthorityTransitionPriorHeadDigest: fixture.prior.envelope.objectDigest,
    });
  });

  it.each(['missing', 'refused'] as const)(
    'fails closed when post-transition authority evidence is $condition',
    async (condition) => {
      const fixture = await rotatedPublishedFixture();
      const prepareCandidateApply = vi.fn();
      const receiver = createAgentProfileCandidateReceiverV1({
        networkId: NETWORK,
        artifacts: {
          resolve: (lookup, signal) => condition === 'missing'
            && lookup.type === 'object'
            && lookup.objectKind === 'authority-transition'
            ? Promise.resolve(null)
            : fixture.resolve(lookup, signal),
        },
        nowMs: () => PRODUCER_FIXTURE_NOW_MS,
        verifyAuthorityEnvelope: (candidate) => condition !== 'refused'
          || candidate.object.objectType !== 'authority-transition',
        verifyCurrentBundle: () => true,
        prepareCandidateApply,
      });

      await expect(receiver.receiveActive(
        fixture.row,
        ADMITTED_CONTEXT,
        new AbortController().signal,
      ))
        .rejects.toThrow(condition === 'missing' ? /missing/ : /authority-transition verification/);
      expect(prepareCandidateApply).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the exact owned-subject table is unavailable', async () => {
    const fixture = await publishedFixture();
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: Object.freeze({
        resolve: (lookup, signal) => lookup.type === 'object'
          && lookup.objectKind === 'owned-subject-table'
          ? Promise.resolve(null)
          : fixture.store.resolve(lookup, signal),
      }),
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, ADMITTED_CONTEXT, new AbortController().signal))
      .rejects.toThrow(/owned-subject table/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('fails closed when the owned-subject table bytes do not bind the verified head', async () => {
    const fixture = await publishedFixture();
    const prepareCandidateApply = vi.fn();
    const alteredTable = Object.freeze([
      fixture.envelope.object.rootSubject,
      deriveAgentProfileOwnedSubjectV1(fixture.envelope.object.rootSubject, 'capability', 1),
    ].sort()) as OwnedSubjectTableObjectV1;
    const alteredBytes = canonicalizeOwnedSubjectTableObjectV1(
      fixture.envelope.object.rootSubject,
      alteredTable,
    );
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: Object.freeze({
        resolve: async (lookup, signal) => {
          const artifact = await fixture.store.resolve(lookup, signal);
          if (artifact === null || lookup.type !== 'object'
            || lookup.objectKind !== 'owned-subject-table') return artifact;
          return Object.freeze({ ...artifact, canonicalBytes: alteredBytes });
        },
      }),
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, ADMITTED_CONTEXT, new AbortController().signal))
      .rejects.toThrow(/does not bind the verified head/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('fails closed when final bundle verification refuses the closure', async () => {
    const fixture = await publishedFixture();
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => false,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, ADMITTED_CONTEXT, new AbortController().signal))
      .rejects.toThrow(/bundle verification failed/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it.each(RECEIVER_HEAD_COUNT_MISMATCH_CASES)(
    'rejects when signed $field does not match the retained projection',
    async ({ patch, error }) => {
      const fixture = await publishedReceiverFixtureWithHeadPatch(patch);
      const verifyCurrentBundle = vi.fn(() => true);
      const prepareCandidateApply = vi.fn();
      const receiver = createAgentProfileCandidateReceiverV1({
        networkId: NETWORK,
        artifacts: fixture.artifacts,
        nowMs: () => PRODUCER_FIXTURE_NOW_MS,
        verifyCurrentBundle,
        prepareCandidateApply,
      });

      await expect(receiver.receiveActive(
        fixture.row,
        ADMITTED_CONTEXT,
        new AbortController().signal,
      ))
        .rejects.toThrow(error);
      expect(verifyCurrentBundle).toHaveBeenCalledOnce();
      expect(prepareCandidateApply).not.toHaveBeenCalled();
    },
  );

  it.each(RECEIVER_CANONICAL_PROJECTION_FAILURE_CASES)(
    'rejects a signed $label after boolean bundle verification', async ({
      transform,
      error,
    }) => {
      const fixture = await publishedReceiverFixtureWithProjectionBytes(transform);
      const verifyCurrentBundle = vi.fn(() => true);
      const prepareCandidateApply = vi.fn();
      const receiver = createAgentProfileCandidateReceiverV1({
        networkId: NETWORK,
        artifacts: fixture.artifacts,
        nowMs: () => PRODUCER_FIXTURE_NOW_MS,
        verifyCurrentBundle,
        prepareCandidateApply,
      });

      await expect(receiver.receiveActive(
        fixture.row,
        ADMITTED_CONTEXT,
        new AbortController().signal,
      ))
        .rejects.toThrow(error);
      expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
      expect(prepareCandidateApply).not.toHaveBeenCalled();
    },
  );

  it.each(RECEIVER_PROFILE_PROJECTION_FAILURE_CASES)(
    'rejects a signed $label before lifecycle preparation', async ({
      transform,
      error,
    }) => {
      const fixture = await publishedReceiverFixtureWithProjectionBytes(transform);
      const verifyCurrentBundle = vi.fn(() => true);
      const prepareCandidateApply = vi.fn();
      const receiver = createAgentProfileCandidateReceiverV1({
        networkId: NETWORK,
        artifacts: fixture.artifacts,
        nowMs: () => PRODUCER_FIXTURE_NOW_MS,
        verifyCurrentBundle,
        prepareCandidateApply,
      });

      await expect(receiver.receiveActive(
        fixture.row,
        ADMITTED_CONTEXT,
        new AbortController().signal,
      ))
        .rejects.toThrow(error);
      expect(verifyCurrentBundle).toHaveBeenCalledOnce();
      expect(prepareCandidateApply).not.toHaveBeenCalled();
    },
  );
  it('isolates signed bundle bytes from mutations by the injected verifier', async () => {
    const fixture = await publishedFixture();
    const signal = new AbortController().signal;
    const bundleArtifact = await fixture.store.resolve({
      type: 'object',
      objectKind: 'profile-bundle',
      objectDigest: fixture.envelope.object.bundleDigest,
    }, signal);
    if (bundleArtifact === null) throw new Error('fixture bundle was not retained');
    const expectedProjectionBytes = Uint8Array.from(
      decodeOpaqueKaBundleV1(bundleArtifact.canonicalBytes).projectionBytes,
    );
    const verifyCurrentBundle = vi.fn((_head, bundleBytes: Uint8Array) => {
      bundleBytes.fill(0);
      return true;
    });
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverAnyCandidateV1,
      _admittedContext: AgentProfileAdmittedSliceContextV1,
      _signal: AbortSignal,
    ) => preparedFixtureApply('4', 'f'));
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, ADMITTED_CONTEXT, signal))
      .resolves.toMatchObject({ outcome: 'applied' });
    expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
    const candidate = prepareCandidateApply.mock.calls[0]![0];
    expect(candidate.canonicalProjectionBytes).toEqual(expectedProjectionBytes);
    expect([...candidate.projectionQuads].sort(compareQuad))
      .toEqual([...fixture.prepared.projectionQuads].sort(compareQuad));
  });

  it('returns a committed apply outcome when cancellation arrives at the point of no return', async () => {
    const fixture = await publishedFixture();
    const controller = new AbortController();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: () => Object.freeze({
        ...DEFAULT_MONOTONIC_APPLY_TIMING,
        apply: () => {
          controller.abort(new Error('late stop'));
          return {
            outcome: 'applied',
            stateRevision: '2',
            appliedStateDigest: `0x${'c'.repeat(64)}`,
          };
        },
      }),
    });

    await expect(receiver.receiveActive(fixture.row, ADMITTED_CONTEXT, controller.signal)).resolves.toEqual({
      outcome: 'applied',
      stateRevision: '2',
      appliedStateDigest: `0x${'c'.repeat(64)}`,
    });
  });

  it('honors cancellation raised during lifecycle apply preparation', async () => {
    const fixture = await publishedFixture();
    const controller = new AbortController();
    const apply = vi.fn(() => ({
      outcome: 'applied' as const,
      stateRevision: '2',
      appliedStateDigest: `0x${'c'.repeat(64)}`,
    }));
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: async () => {
        await Promise.resolve();
        controller.abort(new Error('pre-apply stop'));
        return Object.freeze({ ...DEFAULT_MONOTONIC_APPLY_TIMING, apply });
      },
    });

    await expect(receiver.receiveActive(fixture.row, ADMITTED_CONTEXT, controller.signal))
      .rejects.toThrow('pre-apply stop');
    expect(apply).not.toHaveBeenCalled();
  });

  it('honors a caller abort before resolving any artifact', async () => {
    const resolve = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('test stop'));
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve },
      verifyCurrentBundle: vi.fn(),
      prepareCandidateApply: vi.fn(),
    });
    const row: SystemRecordInventoryRowV1 = {
      stableKeyHash: `0x${'a'.repeat(64)}`,
      peerId: 'unused',
      authoritySequence: '0',
      version: '0',
      headDigest: `0x${'b'.repeat(64)}`,
      tombstone: false,
      quarantined: false,
    };

    await expect(receiver.receiveActive(row, ADMITTED_CONTEXT, controller.signal)).rejects.toThrow('test stop');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects noncanonical conflict metadata before fetching closure artifacts', async () => {
    const fixture = await publishedFixture();
    const resolve = vi.fn(fixture.store.resolve.bind(fixture.store));
    const artifacts = Object.freeze({ resolve });
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: vi.fn(),
    });

    await expect(receivePrepared(
      receiver,
      Object.freeze({
        ...fixture.row,
        conflictEvidenceDigest: ('0x' + 'd'.repeat(64)) as Digest32V1,
      }),
      artifacts,
      new AbortController().signal,
    )).rejects.toThrow(/conflict evidence may appear only on quarantined rows/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('verifies a tombstone predecessor and hands off its exact deletion table once', async () => {
    const fixture = await tombstoneFixture();
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverAnyCandidateV1,
    ) => preparedFixtureApply('7', '7'));
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receivePrepared(
      receiver,
      fixture.row,
      fixture.artifacts,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied', stateRevision: '7' });
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
    const candidate = prepareCandidateApply.mock.calls[0]![0];
    expect(candidate.operation).toBe('tombstone');
    if (candidate.operation !== 'tombstone') throw new Error('expected tombstone candidate');
    expect(candidate.head).toEqual(fixture.tombstone);
    expect(candidate.deletionOwnedSubjectTable).toEqual(
      [...new Set(fixture.prepared.projectionQuads.map(({ subject }) => subject))]
        .sort(compareUtf8),
    );
  });

  it('reconstructs the same tombstone candidate after a cold receiver restart', async () => {
    const fixture = await tombstoneFixture();
    const candidates: AgentProfileReceiverAnyCandidateV1[] = [];
    for (let restart = 0; restart < 2; restart += 1) {
      const receiver = createAgentProfileCandidateReceiverV1({
        networkId: NETWORK,
        artifacts: fixture.artifacts,
        nowMs: () => PRODUCER_FIXTURE_NOW_MS,
        verifyCurrentBundle: () => true,
        prepareCandidateApply: (candidate) => {
          candidates.push(candidate);
          return Object.freeze({
            ...DEFAULT_MONOTONIC_APPLY_TIMING,
            apply: () => Object.freeze({
              outcome: restart === 0 ? 'applied' as const : 'already-current' as const,
              stateRevision: '8',
              appliedStateDigest: '0x' + '8'.repeat(64),
            }),
          });
        },
      });
      await receivePrepared(
        receiver,
        fixture.row,
        fixture.artifacts,
        new AbortController().signal,
      );
    }
    expect(candidates).toHaveLength(2);
    const normalized = candidates.map((candidate) => ({
      operation: candidate.operation,
      head: candidate.head,
      table: candidate.operation === 'tombstone' ? candidate.deletionOwnedSubjectTable : null,
    }));
    expect(normalized[0]).toEqual(normalized[1]);
    expect(normalized[0]).toMatchObject({ operation: 'tombstone', head: fixture.tombstone });
  });

  it('verifies fork quarantine evidence independently of artifact delivery order', async () => {
    const observed: AgentProfileReceiverAnyCandidateV1[] = [];
    for (const reverseDelivery of [false, true]) {
      const fixture = await quarantineFixture(reverseDelivery);
      const verifyCurrentBundle = vi.fn(() => true);
      const nowMs = vi.fn(() => PRODUCER_FIXTURE_NOW_MS);
      const receiver = createAgentProfileCandidateReceiverV1({
        networkId: NETWORK,
        artifacts: fixture.artifacts,
        nowMs,
        verifyCurrentBundle,
        prepareCandidateApply: (candidate) => {
          observed.push(candidate);
          return preparedFixtureApply('9', '9');
        },
      });
      await receivePrepared(
        receiver,
        fixture.row,
        fixture.artifacts,
        new AbortController().signal,
      );
      expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
      // Profile expiry removes discovery eligibility, but must not suppress
      // permanent conflict evidence or shorten its admitted storage deadline.
      expect(nowMs).toHaveBeenCalledTimes(1);
    }
    expect(observed).toHaveLength(2);
    for (const candidate of observed) {
      expect(candidate.operation).toBe('quarantine');
      if (candidate.operation !== 'quarantine') throw new Error('expected quarantine candidate');
      expect(candidate.terminalTransitionConflict).toBe(false);
      expect(candidate.conflictArtifacts.map(({ objectDigest }) => objectDigest))
        .toEqual([...candidate.conflictEvidence.entries[0]!.objectDigests].sort());
    }
    expect(observed[0]!.operation === 'quarantine'
      ? observed[0]!.canonicalConflictEvidenceBytes : null)
      .toEqual(observed[1]!.operation === 'quarantine'
        ? observed[1]!.canonicalConflictEvidenceBytes : null);
  });

  it('resolves conflict sidecars from a repository separate from closure artifacts', async () => {
    const fixture = await quarantineFixture();
    const closureResolve = vi.fn((lookup, signal) => lookup.type === 'object'
      && lookup.objectKind === 'conflict-evidence'
      ? Promise.resolve(null)
      : fixture.artifacts.resolve(lookup, signal));
    const sidecarResolve = vi.fn(fixture.artifacts.resolve.bind(fixture.artifacts));
    const prepareCandidateApply = vi.fn(() => preparedFixtureApply('9', 'a'));
    const receiver = createReceiverWithArtifactSources({
      networkId: NETWORK,
      artifacts: agentProfileArtifactSources(
        Object.freeze({ resolve: closureResolve }),
        Object.freeze({ resolve: sidecarResolve }),
      ),
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveCandidate(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied' });
    expect(sidecarResolve.mock.calls.some(([lookup]) =>
      lookup.type === 'object'
      && lookup.objectKind === 'conflict-evidence'
      && lookup.objectDigest === fixture.evidenceDigest)).toBe(true);
    expect(closureResolve.mock.calls.some(([lookup]) =>
      lookup.type === 'object' && lookup.objectKind === 'conflict-evidence')).toBe(false);
    expect(prepareCandidateApply.mock.calls[0]?.[0].operation).toBe('quarantine');
  });

  it.each(['missing', 'changed'] as const)(
    'fails closed when the closure source returns a %s conflict head from the sidecar',
    async (condition) => {
      const fixture = await quarantineFixture();
      const signal = new AbortController().signal;
      const alternateArtifact = await fixture.artifacts.resolve(Object.freeze({
        type: 'object',
        objectKind: 'agent-profile-head',
        objectDigest: fixture.alternateEnvelope.objectDigest,
      }), signal);
      if (alternateArtifact === null) throw new Error('fixture lacks its alternate head');
      const closureResolve = vi.fn(async (
        lookup: Parameters<SystemRecordArtifactRepositoryV1['resolve']>[0],
        resolveSignal: AbortSignal,
      ) => {
        if (lookup.type === 'object'
            && lookup.objectKind === 'agent-profile-head'
            && lookup.objectDigest === fixture.alternateEnvelope.objectDigest) {
          return condition === 'missing'
            ? null
            : Object.freeze({
              ...alternateArtifact,
              canonicalBytes: Uint8Array.from([...alternateArtifact.canonicalBytes, 0]),
            });
        }
        return fixture.artifacts.resolve(lookup, resolveSignal);
      });
      const verifyCurrentBundle = vi.fn(() => true);
      const prepareCandidateApply = vi.fn();
      const receiver = createReceiverWithArtifactSources({
        networkId: NETWORK,
        artifacts: agentProfileArtifactSources(
          Object.freeze({ resolve: closureResolve }),
          fixture.artifacts,
        ),
        nowMs: () => PRODUCER_FIXTURE_NOW_MS,
        verifyCurrentBundle,
        prepareCandidateApply,
      });

      await expect(receiver.receiveCandidate(
        fixture.row,
        ADMITTED_CONTEXT,
        signal,
      )).rejects.toThrow(/conflict authority resolver changed a sidecar artifact/);
      expect(closureResolve.mock.calls.some(([lookup]) =>
        lookup.type === 'object'
        && lookup.objectKind === 'agent-profile-head'
        && lookup.objectDigest === fixture.alternateEnvelope.objectDigest)).toBe(true);
      expect(verifyCurrentBundle).not.toHaveBeenCalled();
      expect(prepareCandidateApply).not.toHaveBeenCalled();
    },
  );

  it('fails closed when a fork sidecar names a head with invalid authority', async () => {
    const fixture = await quarantineFixture();
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope: (envelope) =>
        envelope.objectDigest !== fixture.alternateEnvelope.objectDigest,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveCandidate(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).rejects.toThrow(/authority|signed head/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('rejects signed fork evidence that omits the advertised row head', async () => {
    const fixture = await quarantineFixture();
    const secondAlternateHead = Object.freeze({
      ...fixture.envelope.object,
      issuedAt: '2026-08-07T12:02:00Z',
    });
    const secondAlternateEnvelope = await signHeadEnvelope(
      secondAlternateHead,
      fixture.peerSigner,
      fixture.evmSigner,
    );
    const evidence: AgentProfileConflictEvidenceV1 = Object.freeze({
      objectType: 'conflict-evidence',
      kind: 'agents',
      networkId: NETWORK,
      peerId: fixture.row.peerId,
      entries: Object.freeze([Object.freeze({
        type: 'fork',
        authoritySequence: fixture.row.authoritySequence,
        version: fixture.row.version,
        objectDigests: Object.freeze([
          fixture.alternateEnvelope.objectDigest,
          secondAlternateEnvelope.objectDigest,
        ].sort()) as readonly Digest32V1[],
      })]),
    });
    const evidenceDigest = computeAgentProfileConflictEvidenceDigestV1(evidence);
    const artifacts = overlayRepository(fixture.artifacts, [
      envelopeArtifact('agent-profile-head', secondAlternateEnvelope),
      Object.freeze({
        objectKind: 'conflict-evidence',
        objectDigest: evidenceDigest,
        canonicalBytes: canonicalizeAgentProfileConflictEvidenceV1(evidence),
      }),
    ]);
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveCandidate(
      Object.freeze({
        ...fixture.row,
        conflictEvidenceDigest: evidenceDigest,
      }),
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).rejects.toThrow(/current quarantined frontier/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('rejects signed same-tuple fork evidence that changes authority', async () => {
    const fixture = await quarantineFixture();
    const alternateSigner = createEvmPersonalMessageSignerV1({
      mode: 'custodial',
      address: new ethers.Wallet(OTHER_PRIVATE_KEY).address,
      privateKey: OTHER_PRIVATE_KEY,
      purpose: 'fork authority mismatch fixture',
    });
    const alternateAddress = alternateSigner.address.toLowerCase();
    const kaNumber = fixture.envelope.object.graphScopedAuthorSeal.kaUal.split('/').at(-1);
    if (kaNumber === undefined) throw new Error('fixture seal lacks a KA number');
    const changedAuthorityHead = Object.freeze({
      ...fixture.envelope.object,
      evmIssuer: alternateAddress,
      rootSubject: `did:dkg:agent:${alternateAddress}`,
      graphScopedAuthorSeal: Object.freeze({
        ...fixture.envelope.object.graphScopedAuthorSeal,
        authorAddress: alternateAddress,
        kaUal: `did:dkg:${NETWORK}/${alternateAddress}/${kaNumber}`,
        reservedKaId: ((BigInt(alternateAddress) << 96n) | BigInt(kaNumber)).toString(),
      }),
      issuedAt: '2026-08-07T12:03:00Z',
    });
    const changedAuthorityEnvelope = await signHeadEnvelope(
      changedAuthorityHead,
      fixture.peerSigner,
      alternateSigner,
    );
    const evidence: AgentProfileConflictEvidenceV1 = Object.freeze({
      objectType: 'conflict-evidence',
      kind: 'agents',
      networkId: NETWORK,
      peerId: fixture.row.peerId,
      entries: Object.freeze([Object.freeze({
        type: 'fork',
        authoritySequence: fixture.row.authoritySequence,
        version: fixture.row.version,
        objectDigests: Object.freeze([
          fixture.envelope.objectDigest,
          changedAuthorityEnvelope.objectDigest,
        ].sort()) as readonly Digest32V1[],
      })]),
    });
    const evidenceDigest = computeAgentProfileConflictEvidenceDigestV1(evidence);
    const artifacts = overlayRepository(fixture.artifacts, [
      envelopeArtifact('agent-profile-head', changedAuthorityEnvelope),
      Object.freeze({
        objectKind: 'conflict-evidence',
        objectDigest: evidenceDigest,
        canonicalBytes: canonicalizeAgentProfileConflictEvidenceV1(evidence),
      }),
    ]);
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveCandidate(
      Object.freeze({ ...fixture.row, conflictEvidenceDigest: evidenceDigest }),
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).rejects.toThrow(/fork evidence changed authority within one head tuple/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('verifies each unique conflict authority envelope once per physical preparation', async () => {
    const fixture = await quarantineFixture();
    const verifyAuthorityEnvelope = vi.fn(() => true);
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: () => preparedFixtureApply('10', 'a'),
    });

    await receivePrepared(
      receiver,
      fixture.row,
      fixture.artifacts,
      new AbortController().signal,
    );
    const verifiedDigests = verifyAuthorityEnvelope.mock.calls
      .map(([envelope]) => envelope.objectDigest);
    expect(verifiedDigests).toHaveLength(new Set(verifiedDigests).size);
    expect(verifiedDigests).toEqual(expect.arrayContaining([
      fixture.envelope.objectDigest,
      fixture.alternateEnvelope.objectDigest,
    ]));
  });

  it('quarantines a disputed tombstone without producing a deletion candidate', async () => {
    const fixture = await activeTombstoneConflictFixture();
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverAnyCandidateV1,
    ) => preparedFixtureApply('11', 'b'));
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await receivePrepared(
      receiver,
      fixture.row,
      fixture.artifacts,
      new AbortController().signal,
    );
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
    const candidate = prepareCandidateApply.mock.calls[0]![0];
    expect(candidate.operation).toBe('quarantine');
    if (candidate.operation !== 'quarantine') throw new Error('expected quarantine candidate');
    expect(candidate.head).toEqual(fixture.active);
    expect(candidate.conflictArtifacts.some(({ objectDigest }) =>
      objectDigest === candidate.conflictEvidence.entries[0]!.objectDigests.find((digest) =>
        digest !== candidate.envelope.objectDigest))).toBe(true);
    expect(candidate).not.toHaveProperty('deletionOwnedSubjectTable');
  });

  it('rejects disputed tombstone evidence without its exact active predecessor', async () => {
    const fixture = await activeTombstoneConflictFixture();
    const artifacts: SystemRecordArtifactRepositoryV1 = Object.freeze({
      resolve: (lookup, signal) => lookup.type === 'object'
        && lookup.objectKind === 'agent-profile-head'
        && lookup.objectDigest === fixture.envelope.objectDigest
        ? Promise.resolve(null)
        : fixture.artifacts.resolve(lookup, signal),
    });
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receivePrepared(
      receiver,
      fixture.row,
      artifacts,
      new AbortController().signal,
    )).rejects.toThrow(/conflict authority closure is missing/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('fails closed instead of deleting when a disputed active bundle is unavailable', async () => {
    const fixture = await activeTombstoneConflictFixture();
    const resolve = vi.fn(async (
      lookup: Parameters<SystemRecordArtifactRepositoryV1['resolve']>[0],
      signal: AbortSignal,
    ) => {
      if (lookup.type === 'object'
          && lookup.objectKind === 'profile-bundle'
          && lookup.objectDigest === fixture.active.bundleDigest) return null;
      return fixture.artifacts.resolve(lookup, signal);
    });
    const verifyCurrentBundle = vi.fn(() => true);
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverAnyCandidateV1,
    ) => preparedFixtureApply('11', 'b'));
    const artifacts = Object.freeze({ resolve });
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receivePrepared(
      receiver,
      fixture.row,
      artifacts,
      new AbortController().signal,
    )).rejects.toThrow(/bundle|closure|required artifact|missing/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
    expect(verifyCurrentBundle).not.toHaveBeenCalled();
    expect(resolve.mock.calls.some(([lookup]) =>
      lookup.type === 'object' && lookup.objectKind === 'profile-bundle')).toBe(true);
  });

  it('does not dispatch disputed quarantine without the active owned-subject table', async () => {
    const fixture = await activeTombstoneConflictFixture();
    let tableLoads = 0;
    const artifacts: SystemRecordArtifactRepositoryV1 = Object.freeze({
      async resolve(lookup, signal) {
        if (lookup.type === 'object'
            && lookup.objectKind === 'owned-subject-table'
            && lookup.objectDigest === fixture.envelope.object.ownedSubjectTableDigest) {
          tableLoads += 1;
          return null;
        }
        return fixture.artifacts.resolve(lookup, signal);
      },
    });
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receivePrepared(
      receiver,
      fixture.row,
      artifacts,
      new AbortController().signal,
    )).rejects.toThrow(/owned-subject-table|closure|required artifact|missing/);
    expect(tableLoads).toBe(1);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('applies ordinary fork quarantine after the advertised active head expires', async () => {
    const fixture = await quarantineFixture();
    const apply = vi.fn(() => Object.freeze({
      outcome: 'applied' as const,
      stateRevision: '12',
      appliedStateDigest: `0x${'12'.repeat(32)}`,
    }));
    const prepareCandidateApply = vi.fn(() => Object.freeze({
      existingMonotonicDeadlineMs: 2_850,
      monotonicNowMs: 1_000,
      apply,
    }));
    const nowMs = vi.fn(() => Date.parse(fixture.envelope.object.validUntil) + 1);
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.artifacts,
      nowMs,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receivePrepared(
      receiver,
      fixture.row,
      fixture.artifacts,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied', stateRevision: '12' });
    expect(prepareCandidateApply.mock.calls[0]?.[0].operation).toBe('quarantine');
    expect(apply).toHaveBeenCalledWith(2_850);
    expect(nowMs).toHaveBeenCalledTimes(1);
  });

  it('fails closed when advertised quarantine evidence is missing', async () => {
    const fixture = await quarantineFixture();
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receivePrepared(
      receiver,
      fixture.row,
      fixture.store,
      new AbortController().signal,
    )).rejects.toThrow(/conflict evidence is missing/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('verifies transition equivocation and marks the quarantine terminal', async () => {
    const fixture = await transitionQuarantineFixture();
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverAnyCandidateV1,
    ) => preparedFixtureApply('10', 'a'));
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await receivePrepared(
      receiver,
      fixture.row,
      fixture.artifacts,
      new AbortController().signal,
    );
    const candidate = prepareCandidateApply.mock.calls[0]![0];
    expect(candidate.operation).toBe('quarantine');
    if (candidate.operation !== 'quarantine') throw new Error('expected quarantine candidate');
    expect(candidate.terminalTransitionConflict).toBe(true);
    expect(candidate.conflictArtifacts).toHaveLength(2);
    expect(candidate.conflictArtifacts.every(({ objectKind }) =>
      objectKind === 'authority-transition')).toBe(true);
  });

  it('fails closed when a competing transition has invalid authority', async () => {
    const fixture = await transitionQuarantineFixture();
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope: (envelope) =>
        envelope.objectDigest !== fixture.competingEnvelope.objectDigest,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveCandidate(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).rejects.toThrow(/authority.*failed|verification.*failed/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('rejects terminal transition evidence unrelated to the retained authority lineage', async () => {
    const fixture = await transitionQuarantineFixture(false, false, true);
    const verifyCurrentBundle = vi.fn(() => true);
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveCandidate(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).rejects.toThrow(/unrelated to the retained authority lineage/);
    expect(verifyCurrentBundle).not.toHaveBeenCalled();
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('rejects terminal transition evidence without its exact accepted predecessor', async () => {
    const fixture = await transitionQuarantineFixture(false, false, false, true);
    const verifyCurrentBundle = vi.fn(() => true);
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveCandidate(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).rejects.toThrow(/transition conflict lacks its exact accepted predecessor/);
    expect(verifyCurrentBundle).not.toHaveBeenCalled();
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('applies terminal transition quarantine after the advertised active head expires', async () => {
    const fixture = await transitionQuarantineFixture();
    const apply = vi.fn(() => Object.freeze({
      outcome: 'applied' as const,
      stateRevision: '13',
      appliedStateDigest: `0x${'13'.repeat(32)}`,
    }));
    const prepareCandidateApply = vi.fn(() => Object.freeze({
      existingMonotonicDeadlineMs: 2_800,
      monotonicNowMs: 1_000,
      apply,
    }));
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.artifacts,
      nowMs: () => Date.parse(fixture.currentHead.validUntil) + 1,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await receivePrepared(
      receiver,
      fixture.row,
      fixture.artifacts,
      new AbortController().signal,
    );
    const candidate = prepareCandidateApply.mock.calls[0]?.[0];
    expect(candidate?.operation).toBe('quarantine');
    if (candidate?.operation !== 'quarantine') throw new Error('expected quarantine candidate');
    expect(candidate.terminalTransitionConflict).toBe(true);
    expect(apply).toHaveBeenCalledWith(2_800);
  });

  it('keeps transition equivocation terminal when the sidecar also advertises a tombstone', async () => {
    const fixture = await transitionQuarantineFixture(false, true);
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverAnyCandidateV1,
    ) => preparedFixtureApply('10', 'a'));
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await receivePrepared(
      receiver,
      fixture.row,
      fixture.artifacts,
      new AbortController().signal,
    );
    const candidate = prepareCandidateApply.mock.calls[0]?.[0];
    expect(candidate?.operation).toBe('quarantine');
    if (candidate?.operation !== 'quarantine') throw new Error('expected quarantine candidate');
    expect(candidate.terminalTransitionConflict).toBe(true);
    expect(candidate.conflictArtifacts).toHaveLength(4);
    expect(candidate.conflictArtifacts.some(({ objectDigest }) =>
      objectDigest === fixture.tombstoneDigest)).toBe(true);
  });

  it('aborts an in-flight conflict fetch without dispatching a candidate', async () => {
    const fixture = await quarantineFixture();
    const controller = new AbortController();
    let requestedEvidence = false;
    const artifacts: SystemRecordArtifactRepositoryV1 = Object.freeze({
      async resolve(lookup, signal) {
        if (lookup.type === 'object' && lookup.objectKind === 'conflict-evidence') {
          requestedEvidence = true;
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return fixture.artifacts.resolve(lookup, signal);
      },
    });
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });
    const received = receivePrepared(receiver, fixture.row, artifacts, controller.signal);
    await vi.waitFor(() => expect(requestedEvidence).toBe(true));
    controller.abort(new Error('stop conflict fetch'));

    await expect(received).rejects.toThrow(/stop conflict fetch/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('rejects conflict evidence beyond the retained object-count boundary', async () => {
    const fixture = await publishedFixture();
    const objectDigests = Array.from({ length: 17 }, (_, index) =>
      ('0x' + index.toString(16).padStart(64, '0')) as Digest32V1);
    expect(() => canonicalizeAgentProfileConflictEvidenceV1({
      objectType: 'conflict-evidence',
      kind: 'agents',
      networkId: NETWORK,
      peerId: fixture.row.peerId,
      entries: [{
        type: 'fork',
        authoritySequence: fixture.row.authoritySequence,
        version: fixture.row.version,
        objectDigests,
      }],
    })).toThrow(/2-16|16 total object digests/);
  });

  it('fails closed when the verified head does not bind the inventory version', async () => {
    const fixture = await publishedFixture();
    const prepareCandidateApply = vi.fn();
    const resolve = vi.fn(fixture.store.resolve.bind(fixture.store));
    const verifyCurrentBundle = vi.fn(
      () => true,
    );
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      Object.freeze({ ...fixture.row, version: '1' }),
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).rejects.toThrow(/inventory row does not bind/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(verifyCurrentBundle).not.toHaveBeenCalled();
  });

  it('fails closed when final authority verification refuses the closure', async () => {
    const fixture = await publishedFixture();
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope: () => false,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).rejects.toThrow(/authority verification failed/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('fails closed when the default authority verifier sees a corrupted head signature', async () => {
    const fixture = await publishedFixture();
    const signature = fixture.envelope.signatures[0]!.signature;
    const corruptedEnvelope = Object.freeze({
      ...fixture.envelope,
      signatures: Object.freeze(fixture.envelope.signatures.map((entry, index) => index === 0
        ? Object.freeze({
          ...entry,
          signature: `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`,
        })
        : entry)),
    }) as typeof fixture.envelope;
    const corruptedArtifact = envelopeArtifact('agent-profile-head', corruptedEnvelope);
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: {
        resolve: (lookup, signal) => lookup.type === 'object'
          && lookup.objectKind === 'agent-profile-head'
          && lookup.objectDigest === fixture.envelope.objectDigest
          ? Promise.resolve(corruptedArtifact)
          : fixture.store.resolve(lookup, signal),
      },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    ))
      .rejects.toThrow(/authority verification failed/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('rejects an oversized artifact before invoking typed-array copy hooks', async () => {
    const fixture = await publishedFixture();
    const prepareCandidateApply = vi.fn();
    class CopyTrapBytes extends Uint8Array {
      override *[Symbol.iterator](): ArrayIterator<number> {
        throw new Error('unbounded artifact copy ran before the cap');
      }
    }
    const receiver = createAgentProfileCandidateReceiverV1({
      networkId: NETWORK,
      artifacts: {
        resolve: async (lookup, signal) => {
          const artifact = await fixture.store.resolve(lookup, signal);
          if (artifact === null || lookup.type !== 'object'
            || lookup.objectKind !== 'agent-profile-head') return artifact;
          return Object.freeze({
            ...artifact,
            canonicalBytes: new CopyTrapBytes(
              SYSTEM_RECORD_OBJECT_CAPS_V1['agent-profile-head'] + 1,
            ),
          });
        },
      },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).rejects.toThrow(/closure artifact exceeds/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('captures lifecycle dependencies once instead of rereading mutable options', async () => {
    const fixture = await publishedFixture();
    const verifyCurrentBundle = vi.fn(
      () => true,
    );
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverAnyCandidateV1,
      _admittedContext: AgentProfileAdmittedSliceContextV1,
      _signal: AbortSignal,
    ) => preparedFixtureApply('3', 'e'));
    const resolveArtifact = vi.fn(fixture.store.resolve.bind(fixture.store));
    const repository = { resolve: resolveArtifact };
    const mutable = {
      networkId: NETWORK,
      artifacts: repository,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    };
    const receiver = createAgentProfileCandidateReceiverV1(mutable);
    mutable.verifyCurrentBundle = vi.fn(() => {
      throw new Error('mutated verifier was observed');
    });
    mutable.prepareCandidateApply = vi.fn(() => {
      throw new Error('mutated materializer was observed');
    });
    repository.resolve = vi.fn(() => {
      throw new Error('mutated repository was observed');
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied', stateRevision: '3' });
    expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
    expect(resolveArtifact).toHaveBeenCalled();
  });

  it('captures the active-only apply callback at receiver construction', async () => {
    const fixture = await publishedFixture();
    const originalApply = vi.fn(() => preparedFixtureApply('4', 'e'));
    const replacementApply = vi.fn(() => {
      throw new Error('mutated active-only materializer was observed');
    });
    const mutable = {
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: originalApply,
    };
    const receiver = createAgentProfileReceiverV1(mutable);
    mutable.prepareCandidateApply = replacementApply;

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied', stateRevision: '4' });
    expect(originalApply).toHaveBeenCalledTimes(1);
    expect(replacementApply).not.toHaveBeenCalled();
  });
});
