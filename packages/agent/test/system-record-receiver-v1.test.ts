import { describe, expect, it, vi } from 'vitest';

import { decodeOpaqueKaBundleV1 } from '@origintrail-official/dkg-core';

import {
  canonicalizeOwnedSubjectTableObjectV1,
  computeSystemRecordStableKeyHashV1,
  deriveAgentProfileOwnedSubjectV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileHeadObjectV1,
  type OwnedSubjectTableObjectV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { ethers } from 'ethers';

import { parseNQuads } from '../src/dkg-agent-utils.js';
import { createEvmPersonalMessageSignerV1 } from '../src/evm-message-signer-v1.js';
import { prepareAgentProfileV1 } from '../src/profile.js';
import { createInMemoryAgentProfilePublicationStoreV1 } from '../src/system-records/in-memory-agent-profile-publication-store-v1.js';
import {
  createAgentProfileReceiverV1,
  type AgentProfileReceiverCandidateV1,
} from '../src/system-records/receiver-v1.js';
import {
  createFixtureAgentProfileProducerV1,
  DEPLOYMENT,
  envelopeArtifact,
  makePrepared,
  NETWORK,
  OTHER_PRIVATE_KEY,
  produce,
  producerFixture,
  PRODUCER_FIXTURE_NOW_MS,
  publicationFor,
  signHeadEnvelope,
  signTransitionEnvelope,
} from './support/agent-profile-producer-v1-fixture.js';

async function publishedFixture(withDerivedSubjects = false) {
  const fixture = await producerFixture();
  const prepared = withDerivedSubjects
    ? prepareAgentProfileV1({
      peerId: fixture.peerSigner.peerId,
      publicKey: Buffer.from(fixture.peerSigner.publicKey, 'base64url').toString('base64'),
      agentAddress: fixture.evmSigner.address,
      name: 'Receiver multi-subject fixture',
      nodeRole: 'edge',
      lastSeen: '2026-08-07T12:00:00.000Z',
      skills: [{
        skillType: 'GraphQuery',
        pricePerCall: 1,
        currency: 'TRAC',
        successRate: 0.99,
        pricingModel: 'PerInvocation',
      }],
      contextGraphsServed: ['receiver-test-graph'],
    })
    : fixture.prepared;
  const publication = withDerivedSubjects
    ? await publicationFor(prepared, fixture.evmSigner.address, '2026-08-07T12:00:00Z')
    : fixture.publication;
  const producer = createFixtureAgentProfileProducerV1({
    networkId: NETWORK,
    publicationDeployment: DEPLOYMENT,
    peerSigner: fixture.peerSigner,
    evmSigner: fixture.evmSigner,
    store: fixture.store,
    fence: () => undefined,
    install: () => undefined,
  });
  await produce(producer, prepared, publication);
  const envelope = fixture.store.snapshot().currentHead;
  if (envelope === null) throw new Error('fixture producer did not publish a head');
  const head = envelope.object;
  const row: SystemRecordInventoryRowV1 = Object.freeze({
    stableKeyHash: computeSystemRecordStableKeyHashV1(head.networkId, head.peerId),
    peerId: head.peerId,
    authoritySequence: head.authoritySequence,
    version: head.version,
    headDigest: envelope.objectDigest,
    tombstone: false,
    quarantined: false,
  });
  return { ...fixture, prepared, publication, envelope, row };
}

async function rotatedPublishedFixture() {
  const prior = await publishedFixture();
  const nextSigner = createEvmPersonalMessageSignerV1({
    mode: 'custodial',
    address: new ethers.Wallet(OTHER_PRIVATE_KEY).address,
    privateKey: OTHER_PRIVATE_KEY,
    purpose: 'receiver post-transition test',
  });
  const prepared = makePrepared(
    prior.peerSigner,
    nextSigner.address,
    '2026-08-07T12:20:00.000Z',
  );
  const publication = await publicationFor(
    prepared,
    nextSigner.address,
    '2026-08-07T12:20:00Z',
    OTHER_PRIVATE_KEY,
  );
  const currentStore = createInMemoryAgentProfilePublicationStoreV1();
  await produce(createFixtureAgentProfileProducerV1({
    networkId: NETWORK,
    publicationDeployment: DEPLOYMENT,
    peerSigner: prior.peerSigner,
    evmSigner: nextSigner,
    store: currentStore,
    fence: () => undefined,
    install: () => undefined,
  }), prepared, publication);
  const bootstrapEnvelope = currentStore.snapshot().currentHead;
  if (bootstrapEnvelope === null) throw new Error('rotated fixture did not publish a head');
  const transition: AgentProfileAuthorityTransitionV1 = Object.freeze({
    objectType: 'authority-transition',
    kind: 'agents',
    mode: 'co-signed',
    networkId: NETWORK,
    peerId: prior.peerSigner.peerId,
    peerPublicKey: prior.peerSigner.publicKey,
    priorAuthoritySequence: '0',
    nextAuthoritySequence: '1',
    priorHeadDigest: prior.envelope.objectDigest,
    priorEvmIssuer: prior.evmSigner.address,
    nextEvmIssuer: nextSigner.address,
    nextRoot: prepared.rootEntity,
    issuedAt: '2026-08-07T12:10:00Z',
  });
  const transitionEnvelope = await signTransitionEnvelope(
    transition,
    prior.peerSigner,
    prior.evmSigner,
    nextSigner,
  );
  const envelope = await signHeadEnvelope(Object.freeze({
    ...bootstrapEnvelope.object,
    authoritySequence: '1',
    acceptedTransitionDigest: transitionEnvelope.objectDigest,
  }), prior.peerSigner, nextSigner);
  const currentHeadArtifact = envelopeArtifact('agent-profile-head', envelope);
  const transitionArtifact = envelopeArtifact('authority-transition', transitionEnvelope);
  const priorHeadArtifact = envelopeArtifact('agent-profile-head', prior.envelope);
  const resolve = vi.fn(async (lookup, signal) => {
    if (lookup.type === 'object') {
      if (lookup.objectKind === currentHeadArtifact.objectKind
        && lookup.objectDigest === currentHeadArtifact.objectDigest) return currentHeadArtifact;
      if (lookup.objectKind === transitionArtifact.objectKind
        && lookup.objectDigest === transitionArtifact.objectDigest) return transitionArtifact;
      if (lookup.objectKind === priorHeadArtifact.objectKind
        && lookup.objectDigest === priorHeadArtifact.objectDigest) return priorHeadArtifact;
    }
    return currentStore.resolve(lookup, signal);
  });
  const head = envelope.object;
  const row: SystemRecordInventoryRowV1 = Object.freeze({
    stableKeyHash: computeSystemRecordStableKeyHashV1(head.networkId, head.peerId),
    peerId: head.peerId,
    authoritySequence: head.authoritySequence,
    version: head.version,
    headDigest: envelope.objectDigest,
    tombstone: false,
    quarantined: false,
  });
  return { prior, prepared, envelope, transitionEnvelope, resolve, row };
}

function verifiedFixtureBundle(bundleBytes: Uint8Array) {
  const { projectionBytes } = decodeOpaqueKaBundleV1(bundleBytes);
  return Object.freeze({
    canonicalProjectionBytes: Uint8Array.from(projectionBytes),
    projectionQuads: Object.freeze(parseNQuads(new TextDecoder().decode(projectionBytes))),
  });
}

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
      return verifiedFixtureBundle(bundleBytes);
    });
    const consumeCandidate = vi.fn(async (_candidate: AgentProfileReceiverCandidateV1) => ({
      outcome: 'applied' as const,
      stateRevision: '1',
      appliedStateDigest: `0x${'a'.repeat(64)}`,
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      consumeCandidate,
    });

    await expect(receiver.receiveActive(fixture.row, signal))
      .resolves.toMatchObject({ outcome: 'applied' });
    expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
    expect(consumeCandidate).toHaveBeenCalledTimes(1);
    const candidate = consumeCandidate.mock.calls[0]![0];
    expect(candidate.head).toEqual(fixture.envelope.object);
    expect(candidate.envelope).toEqual(fixture.envelope);
    expect([...candidate.projectionQuads].sort(compareQuad))
      .toEqual([...fixture.prepared.projectionQuads].sort(compareQuad));
    expect(candidate.ownedSubjectTable).toContain(fixture.prepared.rootEntity);
    expect(candidate.canonicalProjectionBytes).toEqual(
      decodeOpaqueKaBundleV1(bundleArtifact.canonicalBytes).projectionBytes,
    );
    expect(candidate).not.toHaveProperty('signal');
    expect(consumeCandidate.mock.calls[0]![1]).toBe(signal);
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
    const consumeCandidate = vi.fn();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      consumeCandidate,
    });

    await expect(receiver.receiveActive(Object.freeze({
      ...fixture.row,
      version: tombstone.version,
      headDigest: tombstoneEnvelope.objectDigest,
    }), new AbortController().signal)).rejects.toThrow(/inventory row does not bind/);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(verifyCurrentBundle).not.toHaveBeenCalled();
    expect(consumeCandidate).not.toHaveBeenCalled();
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
    const consumeCandidate = vi.fn();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      consumeCandidate,
    });

    await expect(receiver.receiveActive(Object.freeze({
      ...fixture.row,
      headDigest: expiredEnvelope.objectDigest,
    }), new AbortController().signal)).rejects.toThrow(/expired agent-profile head/);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(verifyCurrentBundle).not.toHaveBeenCalled();
    expect(consumeCandidate).not.toHaveBeenCalled();
  });

  it('rechecks freshness immediately before the materialization point of no return', async () => {
    const fixture = await publishedFixture();
    const validUntilMs = Date.parse(fixture.envelope.object.validUntil);
    const nowMs = vi.fn()
      .mockReturnValueOnce(validUntilMs - 1)
      .mockReturnValue(validUntilMs);
    const verifyCurrentBundle = vi.fn(
      (_head, bundleBytes: Uint8Array) => verifiedFixtureBundle(bundleBytes),
    );
    const consumeCandidate = vi.fn();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs,
      verifyCurrentBundle,
      consumeCandidate,
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .rejects.toThrow(/expired agent-profile head/);
    expect(nowMs).toHaveBeenCalledTimes(2);
    expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
    expect(consumeCandidate).not.toHaveBeenCalled();
  });

  it('hands every derived owned subject to the materializer candidate', async () => {
    const fixture = await publishedFixture(true);
    const consumeCandidate = vi.fn(async (_candidate: AgentProfileReceiverCandidateV1) => ({
      outcome: 'applied' as const,
      stateRevision: '1',
      appliedStateDigest: `0x${'a'.repeat(64)}`,
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: (_head, bundleBytes) => verifiedFixtureBundle(bundleBytes),
      consumeCandidate,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      new AbortController().signal,
    )).resolves.toMatchObject({ outcome: 'applied' });
    const candidate = consumeCandidate.mock.calls[0]![0];
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
    const consumeCandidate = vi.fn(async (_candidate: AgentProfileReceiverCandidateV1) => ({
      outcome: 'applied' as const,
      stateRevision: '5',
      appliedStateDigest: `0x${'9'.repeat(64)}`,
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve: fixture.resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope,
      verifyCurrentBundle: (_head, bundleBytes) => verifiedFixtureBundle(bundleBytes),
      consumeCandidate,
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
    const candidate = consumeCandidate.mock.calls[0]![0];
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
      const consumeCandidate = vi.fn();
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
        verifyCurrentBundle: (_head, bundleBytes) => verifiedFixtureBundle(bundleBytes),
        consumeCandidate,
      });

      await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
        .rejects.toThrow(condition === 'missing' ? /missing/ : /authority-transition verification/);
      expect(consumeCandidate).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the exact owned-subject table is unavailable', async () => {
    const fixture = await publishedFixture();
    const consumeCandidate = vi.fn();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: Object.freeze({
        resolve: (lookup, signal) => lookup.type === 'object'
          && lookup.objectKind === 'owned-subject-table'
          ? Promise.resolve(null)
          : fixture.store.resolve(lookup, signal),
      }),
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: (_head, bundleBytes) => verifiedFixtureBundle(bundleBytes),
      consumeCandidate,
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .rejects.toThrow(/owned-subject table/);
    expect(consumeCandidate).not.toHaveBeenCalled();
  });

  it('fails closed when the owned-subject table bytes do not bind the verified head', async () => {
    const fixture = await publishedFixture();
    const consumeCandidate = vi.fn();
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
      verifyCurrentBundle: (_head, bundleBytes) => verifiedFixtureBundle(bundleBytes),
      consumeCandidate,
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .rejects.toThrow(/does not bind the verified head/);
    expect(consumeCandidate).not.toHaveBeenCalled();
  });

  it('fails closed when verified projection bytes do not bind the supplied bundle', async () => {
    const fixture = await publishedFixture();
    const consumeCandidate = vi.fn();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: (_head, bundleBytes) => {
        const verified = verifiedFixtureBundle(bundleBytes);
        return Object.freeze({
          ...verified,
          canonicalProjectionBytes: Uint8Array.from([0]),
        });
      },
      consumeCandidate,
    });

    await expect(receiver.receiveActive(fixture.row, new AbortController().signal))
      .rejects.toThrow(/projection does not bind the supplied bundle/);
    expect(consumeCandidate).not.toHaveBeenCalled();
  });

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
      const verified = verifiedFixtureBundle(Uint8Array.from(bundleBytes));
      bundleBytes.fill(0);
      return verified;
    });
    const consumeCandidate = vi.fn(async (_candidate: AgentProfileReceiverCandidateV1) => ({
      outcome: 'applied' as const,
      stateRevision: '4',
      appliedStateDigest: `0x${'f'.repeat(64)}`,
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      consumeCandidate,
    });

    await expect(receiver.receiveActive(fixture.row, signal))
      .resolves.toMatchObject({ outcome: 'applied' });
    expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
    const candidate = consumeCandidate.mock.calls[0]![0];
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
      verifyCurrentBundle: (_head, bundleBytes) => verifiedFixtureBundle(bundleBytes),
      consumeCandidate: async () => {
        controller.abort(new Error('late stop'));
        return {
          outcome: 'applied',
          stateRevision: '2',
          appliedStateDigest: `0x${'c'.repeat(64)}`,
        };
      },
    });

    await expect(receiver.receiveActive(fixture.row, controller.signal)).resolves.toEqual({
      outcome: 'applied',
      stateRevision: '2',
      appliedStateDigest: `0x${'c'.repeat(64)}`,
    });
  });

  it('honors a caller abort before resolving any artifact', async () => {
    const resolve = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('test stop'));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve },
      verifyCurrentBundle: vi.fn(),
      consumeCandidate: vi.fn(),
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
      verifyCurrentBundle: (_head, bundleBytes) => verifiedFixtureBundle(bundleBytes),
      consumeCandidate: vi.fn(),
    });

    await expect(receiver.receiveActive(
      Object.freeze({ ...fixture.row, ...patch }),
      new AbortController().signal,
    )).rejects.toThrow(error);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('fails closed when the verified head does not bind the inventory version', async () => {
    const fixture = await publishedFixture();
    const consumeCandidate = vi.fn();
    const resolve = vi.fn(fixture.store.resolve.bind(fixture.store));
    const verifyCurrentBundle = vi.fn(
      (_head, bundleBytes: Uint8Array) => verifiedFixtureBundle(bundleBytes),
    );
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: { resolve },
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      consumeCandidate,
    });

    await expect(receiver.receiveActive(
      Object.freeze({ ...fixture.row, version: '1' }),
      new AbortController().signal,
    )).rejects.toThrow(/inventory row does not bind/);
    expect(consumeCandidate).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(verifyCurrentBundle).not.toHaveBeenCalled();
  });

  it('fails closed when final authority verification refuses the closure', async () => {
    const fixture = await publishedFixture();
    const consumeCandidate = vi.fn();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyAuthorityEnvelope: () => false,
      verifyCurrentBundle: (_head, bundleBytes) => verifiedFixtureBundle(bundleBytes),
      consumeCandidate,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      new AbortController().signal,
    )).rejects.toThrow(/authority verification failed/);
    expect(consumeCandidate).not.toHaveBeenCalled();
  });

  it('rejects an oversized artifact before invoking typed-array copy hooks', async () => {
    const fixture = await publishedFixture();
    const consumeCandidate = vi.fn();
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
      verifyCurrentBundle: (_head, bundleBytes) => verifiedFixtureBundle(bundleBytes),
      consumeCandidate,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      new AbortController().signal,
    )).rejects.toThrow(/closure artifact exceeds/);
    expect(consumeCandidate).not.toHaveBeenCalled();
  });

  it('captures lifecycle dependencies once instead of rereading mutable options', async () => {
    const fixture = await publishedFixture();
    const verifyCurrentBundle = vi.fn(
      (_head, bundleBytes: Uint8Array) => verifiedFixtureBundle(bundleBytes),
    );
    const consumeCandidate = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '3',
      appliedStateDigest: `0x${'e'.repeat(64)}`,
    }));
    const resolveArtifact = vi.fn(fixture.store.resolve.bind(fixture.store));
    const repository = { resolve: resolveArtifact };
    const mutable = {
      networkId: NETWORK,
      artifacts: repository,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle,
      consumeCandidate,
    };
    const receiver = createAgentProfileReceiverV1(mutable);
    mutable.verifyCurrentBundle = vi.fn(() => {
      throw new Error('mutated verifier was observed');
    });
    mutable.consumeCandidate = vi.fn(() => {
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
    expect(consumeCandidate).toHaveBeenCalledTimes(1);
    expect(resolveArtifact).toHaveBeenCalled();
  });
});

function compareQuad(
  left: { subject: string; predicate: string; object: string; graph: string },
  right: { subject: string; predicate: string; object: string; graph: string },
): number {
  return left.subject.localeCompare(right.subject)
    || left.predicate.localeCompare(right.predicate)
    || left.object.localeCompare(right.object)
    || left.graph.localeCompare(right.graph);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
