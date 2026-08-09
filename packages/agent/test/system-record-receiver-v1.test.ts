import { describe, expect, it, vi } from 'vitest';

import { decodeOpaqueKaBundleV1 } from '@origintrail-official/dkg-core';

import {
  canonicalizeOwnedSubjectTableObjectV1,
  computeSystemRecordStableKeyHashV1,
  deriveAgentProfileOwnedSubjectV1,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  type OwnedSubjectTableObjectV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { parseNQuads } from '../src/dkg-agent-utils.js';
import {
  createAgentProfileReceiverV1,
} from '../src/system-records/receiver-v1.js';
import {
  createFixtureAgentProfileProducerV1,
  DEPLOYMENT,
  NETWORK,
  produce,
  producerFixture,
  PRODUCER_FIXTURE_NOW_MS,
} from './support/agent-profile-producer-v1-fixture.js';

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
  return { ...fixture, envelope, row };
}

function verifyFixtureBundle(_head: unknown, bundleBytes: Uint8Array) {
  const { projectionBytes } = decodeOpaqueKaBundleV1(bundleBytes);
  return Object.freeze({
    canonicalProjectionBytes: Uint8Array.from(projectionBytes),
    projectionQuads: Object.freeze(parseNQuads(new TextDecoder().decode(projectionBytes))),
  });
}

describe('agent-profile system-record active receiver', () => {
  it('verifies the exact closure and submits one immutable active candidate', async () => {
    const fixture = await publishedFixture();
    const consumeCandidate = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '1',
      appliedStateDigest: `0x${'a'.repeat(64)}`,
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: verifyFixtureBundle,
      consumeCandidate,
    });

    const signal = new AbortController().signal;
    await expect(receiver.receiveActive(fixture.row, signal))
      .resolves.toMatchObject({ outcome: 'applied' });
    expect(consumeCandidate).toHaveBeenCalledTimes(1);
    const candidate = consumeCandidate.mock.calls[0]![0];
    expect(candidate.head).toEqual(fixture.envelope.object);
    expect(candidate.envelope).toEqual(fixture.envelope);
    expect([...candidate.projectionQuads].sort(compareQuad))
      .toEqual([...fixture.prepared.projectionQuads].sort(compareQuad));
    expect(candidate.ownedSubjectTable).toContain(fixture.prepared.rootEntity);
    const bundleArtifact = await fixture.store.resolve({
      type: 'object',
      objectKind: 'profile-bundle',
      objectDigest: fixture.envelope.object.bundleDigest,
    }, signal);
    if (bundleArtifact === null) throw new Error('fixture bundle was not retained');
    expect(candidate.canonicalProjectionBytes).toEqual(
      decodeOpaqueKaBundleV1(bundleArtifact.canonicalBytes).projectionBytes,
    );
    expect(candidate).not.toHaveProperty('signal');
    expect(consumeCandidate.mock.calls[0]![1]).toBe(signal);
  });

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
      verifyCurrentBundle: verifyFixtureBundle,
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
      verifyCurrentBundle: verifyFixtureBundle,
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
      verifyCurrentBundle: (head, bundleBytes) => {
        const verified = verifyFixtureBundle(head, bundleBytes);
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

  it('returns a committed apply outcome when cancellation arrives at the point of no return', async () => {
    const fixture = await publishedFixture();
    const controller = new AbortController();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: verifyFixtureBundle,
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
      verifyCurrentBundle: verifyFixtureBundle,
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
    const verifyCurrentBundle = vi.fn(verifyFixtureBundle);
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
      verifyCurrentBundle: verifyFixtureBundle,
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
      verifyCurrentBundle: verifyFixtureBundle,
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
    const verifyCurrentBundle = vi.fn(verifyFixtureBundle);
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
