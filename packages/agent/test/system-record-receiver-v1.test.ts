import { describe, expect, it, vi } from 'vitest';

import { decodeOpaqueKaBundleV1 } from '@origintrail-official/dkg-core';

import {
  canonicalizeOwnedSubjectTableObjectV1,
  deriveAgentProfileOwnedSubjectV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  type AgentProfileHeadObjectV1,
  type OwnedSubjectTableObjectV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  createAgentProfileReceiverV1,
  type AgentProfileReceiverCandidateV1,
} from '../src/system-records/receiver-v1.js';
import {
  envelopeArtifact,
  NETWORK,
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

describe('agent-profile system-record active receiver', () => {
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
      _candidate: AgentProfileReceiverCandidateV1,
      _signal: AbortSignal,
    ) => preparedFixtureApply('1', 'a'));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, signal))
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
    expect(prepareCandidateApply.mock.calls[0]![1]).toBe(signal);
    expect(prepareCandidateApply.mock.calls[0]).toHaveLength(2);
  });

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
    const receiver = createAgentProfileReceiverV1({
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
    }), new AbortController().signal)).rejects.toThrow(/inventory row does not bind/);
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
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(Object.freeze({
      ...fixture.row,
      headDigest: expiredEnvelope.objectDigest,
    }), new AbortController().signal)).rejects.toThrow(/expired agent-profile head/);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(verifyCurrentBundle).not.toHaveBeenCalled();
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('rechecks freshness immediately before the materialization point of no return', async () => {
    const fixture = await publishedFixture();
    const validUntilMs = Date.parse(fixture.envelope.object.validUntil);
    const nowMs = vi.fn()
      .mockReturnValueOnce(validUntilMs - 1)
      .mockReturnValue(validUntilMs);
    const verifyCurrentBundle = vi.fn(
      () => true,
    );
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .rejects.toThrow(/expired agent-profile head/);
    expect(nowMs).toHaveBeenCalledTimes(2);
    expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('clamps signed wall-clock expiry onto the bridge monotonic deadline', async () => {
    const fixture = await publishedFixture();
    const validUntilUnixMs = Date.parse(fixture.envelope.object.validUntil);
    const nowMs = vi.fn()
      .mockReturnValueOnce(validUntilUnixMs - 100)
      .mockReturnValueOnce(validUntilUnixMs - 80)
      .mockReturnValue(validUntilUnixMs - 60);
    const existingMonotonicDeadlineMs = 5_200;
    const monotonicNowMs = 5_000;
    let admittedDeadlineMs: number | undefined;
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverCandidateV1,
      _signal: AbortSignal,
    ) => Object.freeze({
      existingMonotonicDeadlineMs,
      monotonicNowMs,
      apply: (deadline: number) => {
        admittedDeadlineMs = deadline;
        return {
          outcome: 'applied' as const,
          stateRevision: '6',
          appliedStateDigest: `0x${'8'.repeat(64)}`,
        };
      },
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .resolves.toMatchObject({ outcome: 'applied' });
    expect(nowMs).toHaveBeenCalledTimes(3);
    expect(admittedDeadlineMs).toBe(5_060);
    expect(admittedDeadlineMs).not.toBe(validUntilUnixMs);
  });

  it('preserves an authenticated existing deadline when it is tighter', async () => {
    const fixture = await publishedFixture();
    const validUntilUnixMs = Date.parse(fixture.envelope.object.validUntil);
    const nowMs = vi.fn()
      .mockReturnValueOnce(validUntilUnixMs - 100)
      .mockReturnValueOnce(validUntilUnixMs - 80)
      .mockReturnValue(validUntilUnixMs - 60);
    const apply = vi.fn(() => ({
      outcome: 'applied' as const,
      stateRevision: '6',
      appliedStateDigest: `0x${'8'.repeat(64)}`,
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: () => Object.freeze({
        existingMonotonicDeadlineMs: 5_025,
        monotonicNowMs: 5_000,
        apply,
      }),
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .resolves.toMatchObject({ outcome: 'applied' });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(5_025);
  });

  it('rejects an already-expired authenticated monotonic deadline', async () => {
    const fixture = await publishedFixture();
    const apply = vi.fn();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: () => Object.freeze({
        existingMonotonicDeadlineMs: 5_000,
        monotonicNowMs: 5_000,
        apply,
      }),
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .rejects.toThrow(/monotonic apply admission is expired/);
    expect(apply).not.toHaveBeenCalled();
  });

  it('invokes the prepared lifecycle apply entry exactly once', async () => {
    const fixture = await publishedFixture();
    const apply = vi.fn(() => ({
      outcome: 'applied' as const,
      stateRevision: '6',
      appliedStateDigest: `0x${'8'.repeat(64)}`,
    }));
    const prepareCandidateApply = vi.fn(() => Object.freeze({
      ...DEFAULT_MONOTONIC_APPLY_TIMING,
      apply,
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .resolves.toMatchObject({ outcome: 'applied' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge an apply outcome returned instead of prepared state', async () => {
    const fixture = await publishedFixture();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: vi.fn(async () => Object.freeze({
        outcome: 'applied',
        stateRevision: '6',
        appliedStateDigest: `0x${'8'.repeat(64)}`,
      }) as never),
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .rejects.toThrow(/monotonic apply existing deadline is invalid/);
  });

  it('lets the lifecycle bridge reject expiry after its own asynchronous admission work', async () => {
    const fixture = await publishedFixture();
    const validUntilMs = Date.parse(fixture.envelope.object.validUntil);
    const nowMs = vi.fn()
      .mockReturnValueOnce(validUntilMs - 2)
      .mockReturnValueOnce(validUntilMs - 1)
      .mockReturnValue(validUntilMs);
    const apply = vi.fn(() => ({
      outcome: 'applied' as const,
      stateRevision: '6',
      appliedStateDigest: `0x${'8'.repeat(64)}`,
    }));
    const prepareCandidateApply = vi.fn(async (
      _candidate: AgentProfileReceiverCandidateV1,
      _signal: AbortSignal,
    ) => {
      await Promise.resolve();
      return Object.freeze({ ...DEFAULT_MONOTONIC_APPLY_TIMING, apply });
    });
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .rejects.toThrow(/expired agent-profile head/);
    expect(nowMs).toHaveBeenCalledTimes(3);
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it('hands every derived owned subject to the materializer candidate', async () => {
    const fixture = await publishedFixture(true);
    const prepareCandidateApply = vi.fn((
      _candidate: AgentProfileReceiverCandidateV1,
      _signal: AbortSignal,
    ) => preparedFixtureApply('1', 'a'));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      fixture.row,
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
      _candidate: AgentProfileReceiverCandidateV1,
      _signal: AbortSignal,
    ) => preparedFixtureApply('5', '9'));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve: fixture.resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
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
      const receiver = createAgentProfileReceiverV1({
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

      await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
        .rejects.toThrow(condition === 'missing' ? /missing/ : /authority-transition verification/);
      expect(prepareCandidateApply).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the exact owned-subject table is unavailable', async () => {
    const fixture = await publishedFixture();
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileReceiverV1({
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

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
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
    const receiver = createAgentProfileReceiverV1({
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

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .rejects.toThrow(/does not bind the verified head/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it('fails closed when final bundle verification refuses the closure', async () => {
    const fixture = await publishedFixture();
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => false,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .rejects.toThrow(/bundle verification failed/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
  });

  it.each(RECEIVER_HEAD_COUNT_MISMATCH_CASES)(
    'rejects when signed $field does not match the retained projection',
    async ({ patch, error }) => {
      const fixture = await publishedReceiverFixtureWithHeadPatch(patch);
      const verifyCurrentBundle = vi.fn(() => true);
      const prepareCandidateApply = vi.fn();
      const receiver = createAgentProfileReceiverV1({
        networkId: NETWORK,
        artifacts: fixture.artifacts,
        nowMs: () => PRODUCER_FIXTURE_NOW_MS,
        verifyCurrentBundle,
        prepareCandidateApply,
      });

      await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
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
      const receiver = createAgentProfileReceiverV1({
        networkId: NETWORK,
        artifacts: fixture.artifacts,
        nowMs: () => PRODUCER_FIXTURE_NOW_MS,
        verifyCurrentBundle,
        prepareCandidateApply,
      });

      await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
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
      const receiver = createAgentProfileReceiverV1({
        networkId: NETWORK,
        artifacts: fixture.artifacts,
        nowMs: () => PRODUCER_FIXTURE_NOW_MS,
        verifyCurrentBundle,
        prepareCandidateApply,
      });

      await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
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
      _candidate: AgentProfileReceiverCandidateV1,
      _signal: AbortSignal,
    ) => preparedFixtureApply('4', 'f'));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(fixture.row, signal))
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
    const receiver = createAgentProfileReceiverV1({
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

    await expect(receiver.receiveActive(fixture.row, controller.signal)).resolves.toEqual({
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
    const receiver = createAgentProfileReceiverV1({
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

    await expect(receiver.receiveActive(fixture.row, controller.signal))
      .rejects.toThrow('pre-apply stop');
    expect(apply).not.toHaveBeenCalled();
  });

  it('honors a caller abort before resolving any artifact', async () => {
    const resolve = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('test stop'));
    const receiver = createAgentProfileReceiverV1({
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

    await expect(receiver.receiveActive(row, controller.signal)).rejects.toThrow('test stop');
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'tombstone',
      patch: { tombstone: true },
      error: /ordinary active inventory row/,
    },
    {
      label: 'quarantined',
      patch: {
        quarantined: true,
        conflictEvidenceDigest: `0x${'d'.repeat(64)}`,
      },
      error: /ordinary active inventory row/,
    },
    {
      label: 'conflict evidence',
      patch: { conflictEvidenceDigest: `0x${'d'.repeat(64)}` },
      error: /conflict evidence may appear only on quarantined rows|ordinary active inventory row/,
    },
  ])('rejects a $label row before fetching closure artifacts', async ({ patch, error }) => {
    const fixture = await publishedFixture();
    const resolve = vi.fn(fixture.store.resolve.bind(fixture.store));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: vi.fn(),
    });

    await expect(receiver.receiveActive(
      Object.freeze({ ...fixture.row, ...patch }),
      new AbortController().signal,
    )).rejects.toThrow(error);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('fails closed when the verified head does not bind the inventory version', async () => {
    const fixture = await publishedFixture();
    const prepareCandidateApply = vi.fn();
    const resolve = vi.fn(fixture.store.resolve.bind(fixture.store));
    const verifyCurrentBundle = vi.fn(
      () => true,
    );
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      Object.freeze({ ...fixture.row, version: '1' }),
      new AbortController().signal,
    )).rejects.toThrow(/inventory row does not bind/);
    expect(prepareCandidateApply).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(verifyCurrentBundle).not.toHaveBeenCalled();
  });

  it('fails closed when final authority verification refuses the closure', async () => {
    const fixture = await publishedFixture();
    const prepareCandidateApply = vi.fn();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope: () => false,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      fixture.row,
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
    const receiver = createAgentProfileReceiverV1({
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

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
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
    const receiver = createAgentProfileReceiverV1({
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
      _candidate: AgentProfileReceiverCandidateV1,
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
    const receiver = createAgentProfileReceiverV1(mutable);
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
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied', stateRevision: '3' });
    expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
    expect(resolveArtifact).toHaveBeenCalled();
  });
});
