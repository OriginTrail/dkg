import { ed25519 } from '@noble/curves/ed25519.js';
import {
  SENTINEL_NO_PRIVATE_V10,
  V10MerkleTree,
  keccak256,
  tripleContentV10,
  buildAuthorAttestationTypedData,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
} from '@origintrail-official/dkg-core';
import {
  SYSTEM_RECORD_MAX_CLOCK_SKEW_MS,
  buildSystemRecordSignatureMessageV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileHeadObjectV1,
  type Digest32V1,
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SystemRecordPeerPublicKeyV1,
  type SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import {
  createEvmPersonalMessageSignerV1,
  type EvmPersonalMessageSignerV1,
} from '../src/evm-message-signer-v1.js';
import { prepareAgentProfileV1, type PreparedAgentProfileV1 } from '../src/profile.js';
import {
  createAgentProfileProducerV1,
  type AgentProfileProducerPublicationCommitV1,
  type AgentProfileProducerPublicationStoreV1,
  type AgentProfileProducerV1,
  type AgentProfilePublicationBindingV1,
  type SystemRecordPeerSignerV1,
} from '../src/system-records/agent-profile-producer-v1.js';
import {
  createInMemoryAgentProfilePublicationStoreV1,
  type InMemoryAgentProfilePublicationStoreV1,
} from '../src/system-records/in-memory-agent-profile-publication-store-v1.js';
import {
  systemRecordProviderArtifactKeyV1,
  type SystemRecordProviderArtifactV1,
} from '../src/system-records/provider-v1.js';

const NETWORK = 'base:84532' as const;
const SCHEMA_DIGEST = `0x${'ab'.repeat(32)}` as Digest32V1;
const PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const OTHER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK,
  assertedAtChainId: '84532',
  assertedAtKav10Address: `0x${'44'.repeat(20)}`,
}) as unknown as CatalogSealDeploymentProfileV1;

describe('agent-profile system-record producer V1', () => {
  it('stages one exact profile, installs it, then advertises the signed inventory root', async () => {
    const fixture = await producerFixture();
    const events: string[] = [];
    const store = observingStore(fixture.store, events);
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store,
      fence: () => { events.push('fence'); },
      install: (input) => {
        events.push('install');
        expect(input.projectionQuads).toHaveLength(fixture.prepared.quads.length);
        expect(input.head.rootSubject).toBe(fixture.prepared.rootEntity);
        expect(input.verifiedAuthoritySummary.candidateHeadDigest).toBe(input.envelope.objectDigest);
      },
    });

    const result = await produce(producer, fixture.prepared, fixture.publication);
    expect(result).toMatchObject({ version: '0', authoritySequence: '0' });
    expect(result.inventoryWrites).toBe(2);
    expect(events).toEqual(['fence', 'install', 'advertise']);

    const snapshot = store.snapshot();
    expect(snapshot.currentHead?.objectDigest).toBe(result.headDigest);
    expect(snapshot.inventory?.descriptorDigest).toBe(result.rootDescriptorDigest);
    const head = await store.resolve(controlRequest(result.headDigest), new AbortController().signal);
    expect(head?.objectKind).toBe('agent-profile-head');
    expect(parseCanonicalSignedAgentProfileHeadEnvelopeV1(head!.canonicalBytes).object.version).toBe('0');
    const root = await store.resolve(rootRequest(), new AbortController().signal);
    expect(root?.objectKind).toBe('root-descriptor');
    expect(root?.objectDigest).toBe(result.rootDescriptorDigest);
  });

  it('advances one COW path for an ordinary same-authority heartbeat', async () => {
    const fixture = await producerFixture();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });
    const first = await produce(producer, fixture.prepared, fixture.publication);
    const nextPrepared = makePrepared(
      fixture.peerSigner,
      fixture.evmSigner.address,
      '2026-08-07T12:20:00.000Z',
    );
    const second = await produce(
      producer,
      nextPrepared,
      await publicationFor(nextPrepared, fixture.evmSigner.address, '2026-08-07T12:20:00Z'),
    );

    expect(second.version).toBe('1');
    expect(second.headDigest).not.toBe(first.headDigest);
    expect(second.rootDescriptorDigest).not.toBe(first.rootDescriptorDigest);
    expect(second.inventoryWrites).toBeLessThanOrEqual(6);
    expect(second.inventoryWriteBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(fixture.store.snapshot().inventory?.descriptor.totalRows).toBe('1');
  });

  it('rejects a concurrent stale writer before installing or replacing the winning head', async () => {
    const fixture = await producerFixture();
    const install = vi.fn();
    const firstProducer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install,
    });
    const secondProducer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install,
    });
    const laterPublication = await publicationFor(
      fixture.prepared,
      fixture.evmSigner.address,
      '2026-08-07T12:01:00Z',
    );

    const outcomes = await Promise.allSettled([
      produce(firstProducer, fixture.prepared, fixture.publication),
      produce(secondProducer, fixture.prepared, laterPublication),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof produce>>> =>
        outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toMatch(/prepared commit|snapshot is stale/);
    expect(install).toHaveBeenCalledTimes(1);
    expect(fixture.store.snapshot().currentHead?.objectDigest)
      .toBe(fulfilled[0]!.value.headDigest);
  });

  it('rejects ordinary update authority and schema changes without replacing the head', async () => {
    const fixture = await producerFixture();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });
    const first = await produce(producer, fixture.prepared, fixture.publication);
    const nextPrepared = makePrepared(
      fixture.peerSigner,
      fixture.evmSigner.address,
      '2026-08-07T12:20:00.000Z',
    );
    const nextPublication = await publicationFor(
      nextPrepared,
      fixture.evmSigner.address,
      '2026-08-07T12:20:00Z',
    );
    await expect(produce(producer, nextPrepared, {
      ...nextPublication,
      projectionSchemaDigest: `0x${'cd'.repeat(32)}` as Digest32V1,
    })).rejects.toThrow(/changed its root or projection schema/);
    expect(fixture.store.snapshot().currentHead?.objectDigest).toBe(first.headDigest);

    const otherSigner = createEvmPersonalMessageSignerV1({
      mode: 'custodial',
      address: new ethers.Wallet(OTHER_PRIVATE_KEY).address,
      privateKey: OTHER_PRIVATE_KEY,
      purpose: 'system-record alternate authority test',
    });
    const otherPrepared = makePrepared(
      fixture.peerSigner,
      otherSigner.address,
      '2026-08-07T12:40:00.000Z',
    );
    const otherProducer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: otherSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });
    const lease = await otherProducer.prepare(otherPrepared);
    await expect(lease.complete(nextPublication)).rejects.toThrow(/authority transition/);
    expect(fixture.store.snapshot().currentHead?.objectDigest).toBe(first.headDigest);
  });

  it('preserves verified authority lineage on a post-transition heartbeat', async () => {
    const prior = await producerFixture();
    const priorProducer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: prior.peerSigner,
      evmSigner: prior.evmSigner,
      store: prior.store,
      fence: () => {},
      install: () => {},
    });
    await produce(priorProducer, prior.prepared, prior.publication);
    const priorEnvelope = prior.store.snapshot().currentHead!;

    const nextSigner = createEvmPersonalMessageSignerV1({
      mode: 'custodial',
      address: new ethers.Wallet(OTHER_PRIVATE_KEY).address,
      privateKey: OTHER_PRIVATE_KEY,
      purpose: 'post-transition profile test',
    });
    const transitionedPrepared = makePrepared(
      prior.peerSigner,
      nextSigner.address,
      '2026-08-07T12:20:00.000Z',
    );
    const transitionedPublication = await publicationFor(
      transitionedPrepared,
      nextSigner.address,
      '2026-08-07T12:20:00Z',
      OTHER_PRIVATE_KEY,
    );
    const bootstrapStore = createInMemoryAgentProfilePublicationStoreV1();
    const bootstrapProducer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: prior.peerSigner,
      evmSigner: nextSigner,
      store: bootstrapStore,
      fence: () => {},
      install: () => {},
    });
    await produce(bootstrapProducer, transitionedPrepared, transitionedPublication);
    const bootstrapEnvelope = bootstrapStore.snapshot().currentHead!;

    const transition: AgentProfileAuthorityTransitionV1 = {
      objectType: 'authority-transition',
      kind: 'agents',
      mode: 'co-signed',
      networkId: NETWORK,
      peerId: prior.peerSigner.peerId,
      peerPublicKey: prior.peerSigner.publicKey,
      priorAuthoritySequence: '0',
      nextAuthoritySequence: '1',
      priorHeadDigest: priorEnvelope.objectDigest,
      priorEvmIssuer: prior.evmSigner.address,
      nextEvmIssuer: nextSigner.address,
      nextRoot: transitionedPrepared.rootEntity,
      issuedAt: '2026-08-07T12:10:00Z',
    };
    const transitionEnvelope = await signTransitionEnvelope(
      transition,
      prior.peerSigner,
      prior.evmSigner,
      nextSigner,
    );
    const transitionedEnvelope = await signHeadEnvelope({
      ...bootstrapEnvelope.object,
      authoritySequence: '1',
      acceptedTransitionDigest: transitionEnvelope.objectDigest,
    }, prior.peerSigner, nextSigner);
    const history = new Map<string, SystemRecordProviderArtifactV1>();
    for (const artifact of [
      envelopeArtifact('agent-profile-head', priorEnvelope),
      envelopeArtifact('authority-transition', transitionEnvelope),
    ]) {
      history.set(systemRecordProviderArtifactKeyV1(artifact), artifact);
    }
    let pendingCommit: AgentProfileProducerPublicationCommitV1 | null = null;
    const store: AgentProfileProducerPublicationStoreV1 = {
      snapshot: () => Object.freeze({ inventory: null, currentHead: transitionedEnvelope }),
      resolveArtifact: (reference) => history.get(systemRecordProviderArtifactKeyV1(reference)) ?? null,
      prepareCommit: (input) => {
        pendingCommit = input;
        return Object.freeze({ commit: () => {}, abort: () => {} });
      },
    };
    const heartbeatPrepared = makePrepared(
      prior.peerSigner,
      nextSigner.address,
      '2026-08-07T12:30:00.000Z',
    );
    const heartbeatProducer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: prior.peerSigner,
      evmSigner: nextSigner,
      store,
      fence: () => {},
      install: () => {},
    });

    const result = await produce(
      heartbeatProducer,
      heartbeatPrepared,
      await publicationFor(
        heartbeatPrepared,
        nextSigner.address,
        '2026-08-07T12:30:00Z',
        OTHER_PRIVATE_KEY,
      ),
    );
    const headArtifact = pendingCommit!.artifacts.find(
      (artifact) => artifact.objectKind === 'agent-profile-head',
    )!;
    const heartbeatEnvelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(
      headArtifact.canonicalBytes,
    );
    expect(result).toMatchObject({ authoritySequence: '1', version: '1' });
    expect(heartbeatEnvelope.object.acceptedTransitionDigest)
      .toBe(transitionEnvelope.objectDigest);
    expect(heartbeatEnvelope.object.previousHeadDigest).toBe(transitionedEnvelope.objectDigest);
  });

  it('preflights provider capacity before materialization and releases a failed commit lease', async () => {
    const fixture = await producerFixture(createInMemoryAgentProfilePublicationStoreV1({
      maxObjects: 1,
      maxBytes: 1024 * 1024,
    }));
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install,
    });
    await expect(produce(producer, fixture.prepared, fixture.publication))
      .rejects.toThrow(/cache capacity exhausted/);
    expect(install).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();

    const durableStore = createInMemoryAgentProfilePublicationStoreV1();
    const retryFixture = await producerFixture(durableStore);
    let fail = true;
    const retrying = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: retryFixture.peerSigner,
      evmSigner: retryFixture.evmSigner,
      store: durableStore,
      fence: () => {},
      install: () => {
        if (fail) throw new Error('injected materialization failure');
      },
    });
    await expect(produce(retrying, retryFixture.prepared, retryFixture.publication))
      .rejects.toThrow(/injected materialization failure/);
    expect(durableStore.snapshot().currentHead).toBeNull();
    fail = false;
    await expect(produce(retrying, retryFixture.prepared, retryFixture.publication)).resolves.toMatchObject({
      version: '0',
    });
  });

  it('counts the retained root descriptor against cache capacity on rollover', async () => {
    const store = createInMemoryAgentProfilePublicationStoreV1({
      maxObjects: 7,
      maxBytes: 1024 * 1024,
    });
    const fixture = await producerFixture(store);
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store,
      fence: () => {},
      install: () => {},
    });
    const first = await produce(producer, fixture.prepared, fixture.publication);
    const nextPrepared = makePrepared(
      fixture.peerSigner,
      fixture.evmSigner.address,
      '2026-08-07T12:20:00.000Z',
    );

    await expect(produce(
      producer,
      nextPrepared,
      await publicationFor(nextPrepared, fixture.evmSigner.address, '2026-08-07T12:20:00Z'),
    )).rejects.toThrow(/cache capacity exhausted/);
    expect(store.snapshot().currentHead?.objectDigest).toBe(first.headDigest);
  });

  it('does not expose mutable store state through snapshots', async () => {
    const fixture = await producerFixture();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });
    const published = await produce(producer, fixture.prepared, fixture.publication);
    const snapshot = fixture.store.snapshot();
    (snapshot.inventory!.objects as Map<unknown, unknown>).clear();
    (snapshot.currentHead!.object as { version: string }).version = '99';

    const fresh = fixture.store.snapshot();
    expect(fresh.inventory!.objects.size).toBeGreaterThan(0);
    expect(fresh.currentHead?.objectDigest).toBe(published.headDigest);
    expect(fresh.currentHead?.object.version).toBe('0');
  });

  it('defensively snapshots a structurally valid mutable prepared profile', async () => {
    const fixture = await producerFixture();
    const fence = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install: () => {},
    });
    const mutable = {
      quads: fixture.prepared.quads.map((quad) => ({ ...quad })),
      rootEntity: fixture.prepared.rootEntity,
      lastSeen: fixture.prepared.lastSeen,
    };

    const lease = await producer.prepare(mutable);
    mutable.quads.length = 0;
    mutable.rootEntity = 'urn:mutated-after-prepare';
    await expect(lease.complete(fixture.publication)).resolves.toMatchObject({ version: '0' });
    expect(fence).toHaveBeenCalledWith(
      expect.objectContaining({ rootEntity: fixture.prepared.rootEntity }),
      expect.any(AbortSignal),
    );
    expect(fixture.store.snapshot().currentHead?.object.rootSubject)
      .toBe(fixture.prepared.rootEntity);
  });

  it('fails closed when the publication seal is not for the exact prepared bytes', async () => {
    const fixture = await producerFixture();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });
    const tampered = {
      ...fixture.publication,
      seal: { ...fixture.publication.seal, assertionMerkleRoot: `0x${'cd'.repeat(32)}` },
    } as AgentProfilePublicationBindingV1;
    await expect(produce(producer, fixture.prepared, tampered)).rejects.toThrow(/exact public projection/);
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it.each([
    [
      'a non-confirmed publication',
      (publication: AgentProfilePublicationBindingV1) => ({
        ...publication,
        publicationStatus: 'tentative',
      }),
      /requires a confirmed publication/,
    ],
    [
      'a different author address',
      (publication: AgentProfilePublicationBindingV1) => ({
        ...publication,
        seal: { ...publication.seal, authorAddress: new ethers.Wallet(OTHER_PRIVATE_KEY).address.toLowerCase() },
      }),
      /exact public projection/,
    ],
    [
      'a wrong public triple count',
      (publication: AgentProfilePublicationBindingV1) => ({
        ...publication,
        seal: { ...publication.seal, publicTripleCount: '999' },
      }),
      /exact public projection/,
    ],
    [
      'private triples',
      (publication: AgentProfilePublicationBindingV1) => ({
        ...publication,
        seal: { ...publication.seal, privateTripleCount: '1' },
      }),
      /exact public projection/,
    ],
    [
      'a private Merkle root',
      (publication: AgentProfilePublicationBindingV1) => ({
        ...publication,
        seal: { ...publication.seal, privateMerkleRoot: `0x${'cd'.repeat(32)}` },
      }),
      /exact public projection/,
    ],
  ])('rejects publication binding with %s before installation', async (_label, mutate, expected) => {
    const fixture = await producerFixture();
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install,
    });
    const publication = mutate(fixture.publication) as unknown as AgentProfilePublicationBindingV1;

    await expect(produce(producer, fixture.prepared, publication)).rejects.toThrow(expected);
    expect(install).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it('rejects a future-dated publication against an independent producer clock', async () => {
    const fixture = await producerFixture();
    const install = vi.fn();
    const peerSign = vi.fn(fixture.peerSigner.sign);
    const nowMs = Date.parse('2026-08-07T12:00:00Z');
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: { ...fixture.peerSigner, sign: peerSign },
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      nowMs: () => nowMs,
      fence: () => {},
      install,
    });
    const issuedAt = new Date(nowMs + SYSTEM_RECORD_MAX_CLOCK_SKEW_MS + 1_000)
      .toISOString()
      .replace('.000Z', 'Z');

    await expect(produce(
      producer,
      fixture.prepared,
      await publicationFor(fixture.prepared, fixture.evmSigner.address, issuedAt),
    )).rejects.toThrow(/future clock-skew bound/);
    expect(peerSign).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it.each([
    [
      'a foreign UAL network',
      (publication: AgentProfilePublicationBindingV1) => ({
        ...publication,
        seal: {
          ...publication.seal,
          kaUal: publication.seal.kaUal.replace('did:dkg:base:84532/', 'did:dkg:base:1/'),
        },
      }),
    ],
    [
      'a foreign KAv10 deployment',
      (publication: AgentProfilePublicationBindingV1) => ({
        ...publication,
        seal: {
          ...publication.seal,
          assertedAtKav10Address: `0x${'55'.repeat(20)}`,
        },
      }),
    ],
  ])('rejects %s before signing or publication side effects', async (_label, mutate) => {
    const fixture = await producerFixture();
    const peerSign = vi.fn(fixture.peerSigner.sign);
    const evmSignMessage = vi.fn(fixture.evmSigner.signMessage);
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: { ...fixture.peerSigner, sign: peerSign },
      evmSigner: { ...fixture.evmSigner, signMessage: evmSignMessage },
      store: fixture.store,
      fence: () => {},
      install,
    });
    const publication = mutate(fixture.publication) as unknown as AgentProfilePublicationBindingV1;

    await expect(produce(producer, fixture.prepared, publication))
      .rejects.toThrow(/different network or deployment/);
    expect(peerSign).not.toHaveBeenCalled();
    expect(evmSignMessage).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it('rejects a non-positive validity window before signing or committing', async () => {
    const fixture = await producerFixture();
    const peerSign = vi.fn(fixture.peerSigner.sign);
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: { ...fixture.peerSigner, sign: peerSign },
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install,
    });

    await expect(produce(producer, fixture.prepared, {
      ...fixture.publication,
      validUntil: fixture.publication.issuedAt,
    })).rejects.toThrow(/validUntil must be later than issuedAt/);
    expect(peerSign).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it('normalizes millisecond publication timestamps before signing the head', async () => {
    const fixture = await producerFixture();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });
    await produce(producer, fixture.prepared, {
      ...fixture.publication,
      issuedAt: '2026-08-07T12:00:00.123Z',
      validUntil: '2026-08-08T12:00:00.987Z',
    });

    expect(fixture.store.snapshot().currentHead?.object).toMatchObject({
      issuedAt: '2026-08-07T12:00:00Z',
      validUntil: '2026-08-08T12:00:00Z',
    });
  });

  it('rejects invalid publication timestamp scalars before signing or committing', async () => {
    const fixture = await producerFixture();
    const peerSign = vi.fn(fixture.peerSigner.sign);
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: { ...fixture.peerSigner, sign: peerSign },
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });

    await expect(produce(producer, fixture.prepared, {
      ...fixture.publication,
      issuedAt: '2026-02-30T12:00:00.000Z',
    })).rejects.toThrow(/calendar-valid/);
    expect(peerSign).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it('rejects a seal whose author attestation does not recover the profile authority', async () => {
    const fixture = await producerFixture();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });
    const tampered = {
      ...fixture.publication,
      seal: {
        ...fixture.publication.seal,
        authorAttestationR: `0x${'22'.repeat(32)}`,
        authorAttestationVS: `0x${'33'.repeat(32)}`,
      },
    } as AgentProfilePublicationBindingV1;
    await expect(produce(producer, fixture.prepared, tampered))
      .rejects.toThrow(/attestation does not recover/);
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it('fences before publication and an aborted lease releases the local single-flight', async () => {
    const fixture = await producerFixture();
    const fence = vi.fn();
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install,
    });
    const first = await producer.prepare(fixture.prepared);
    expect(fence).toHaveBeenCalledTimes(1);
    await expect(producer.prepare(fixture.prepared)).rejects.toThrow(/busy/);
    first.abort();
    const retry = await producer.prepare(fixture.prepared);
    retry.abort();
    expect(fence).toHaveBeenCalledTimes(2);
    expect(install).not.toHaveBeenCalled();
  });

  it('rejects duplicate canonical profile triples before fencing publication', async () => {
    const fixture = await producerFixture();
    const fence = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install: () => {},
    });
    const duplicate = Object.freeze({
      ...fixture.prepared,
      quads: Object.freeze([...fixture.prepared.quads, fixture.prepared.quads[0]!]),
    });

    await expect(producer.prepare(duplicate)).rejects.toThrow(/duplicate-free/);
    expect(fence).not.toHaveBeenCalled();
  });

  it.each([
    ['peerId', '"12D3KooWRhLYc1qpzVncrVpMkykB3ML1PoQ9G9gX9X9G9gX9X9G"'],
    ['agentAddress', `"0x${'33'.repeat(20)}"`],
    ['publicKey', '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="'],
  ])('rejects a mismatched advertised %s before fencing publication', async (field, object) => {
    const fixture = await producerFixture();
    const fence = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install: () => {},
    });
    const predicate = `https://dkg.network/ontology#${field}`;
    const mismatched = Object.freeze({
      ...fixture.prepared,
      quads: Object.freeze(fixture.prepared.quads.map((quad) => Object.freeze(
        quad.predicate === predicate ? { ...quad, object } : quad,
      ))),
    });

    await expect(producer.prepare(mismatched)).rejects.toThrow(/does not bind the signed/);
    expect(fence).not.toHaveBeenCalled();
  });

  it.each([
    ['peerId', '"12D3KooWRhLYc1qpzVncrVpMkykB3ML1PoQ9G9gX9X9G9gX9X9G"'],
    ['agentAddress', `"0x${'33'.repeat(20)}"`],
    ['publicKey', '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="'],
  ])('rejects a conflicting advertised %s before fencing publication', async (field, object) => {
    const fixture = await producerFixture();
    const fence = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence,
      install: () => {},
    });
    const conflicting = Object.freeze({
      ...fixture.prepared,
      quads: Object.freeze([
        ...fixture.prepared.quads,
        Object.freeze({
          subject: fixture.prepared.rootEntity,
          predicate: `https://dkg.network/ontology#${field}`,
          object,
          graph: fixture.prepared.quads[0]!.graph,
        }),
      ]),
    });

    await expect(producer.prepare(conflicting)).rejects.toThrow(/does not bind the signed/);
    expect(fence).not.toHaveBeenCalled();
  });
});

async function produce(
  producer: AgentProfileProducerV1,
  prepared: PreparedAgentProfileV1,
  publication: AgentProfilePublicationBindingV1,
) {
  const lease = await producer.prepare(prepared);
  return lease.complete(publication);
}

async function producerFixture(
  store = createInMemoryAgentProfilePublicationStoreV1(),
) {
  const peerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const peerSigner: SystemRecordPeerSignerV1 = Object.freeze({
    peerId: '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf',
    publicKey: 'ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ' as SystemRecordPeerPublicKeyV1,
    sign: async (message: Uint8Array) => ed25519.sign(message, peerSeed),
  });
  const evmSigner = createEvmPersonalMessageSignerV1({
    mode: 'custodial',
    address: new ethers.Wallet(PRIVATE_KEY).address,
    privateKey: PRIVATE_KEY,
    purpose: 'system-record test',
  });
  const prepared = makePrepared(peerSigner, evmSigner.address, '2026-08-07T12:00:00.000Z');
  return {
    peerSigner,
    evmSigner,
    prepared,
    publication: await publicationFor(prepared, evmSigner.address, '2026-08-07T12:00:00Z'),
    store,
  };
}

function makePrepared(
  peerSigner: SystemRecordPeerSignerV1,
  address: string,
  lastSeen: string,
): PreparedAgentProfileV1 {
  return prepareAgentProfileV1({
    peerId: peerSigner.peerId,
    publicKey: Buffer.from(peerSigner.publicKey, 'base64url').toString('base64'),
    agentAddress: address,
    name: 'Fixture node',
    nodeRole: 'edge',
    lastSeen,
    skills: [],
  });
}

async function publicationFor(
  prepared: PreparedAgentProfileV1,
  address: string,
  issuedAt: string,
  privateKey = PRIVATE_KEY,
): Promise<AgentProfilePublicationBindingV1> {
  const canonicalAddress = address.toLowerCase();
  const reservedKaId = (BigInt(canonicalAddress) << 96n) | 7n;
  const assertionMerkleRoot = projectionContentDigest(prepared);
  const typedData = buildAuthorAttestationTypedData({
    chainId: 84532n,
    kav10Address: `0x${'44'.repeat(20)}`,
    merkleRoot: ethers.getBytes(assertionMerkleRoot),
    authorAddress: canonicalAddress,
    reservedKaId,
  });
  const signature = ethers.Signature.from(await new ethers.Wallet(privateKey).signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  return Object.freeze({
    publicationStatus: 'confirmed',
    assertionCoordinate: 'agent-profile-v1' as never,
    seal: Object.freeze({
      assertionMerkleRoot,
      authorAddress: canonicalAddress,
      authorAttestationR: signature.r,
      authorAttestationVS: signature.yParityAndS,
      authorSchemeVersion: '1',
      assertedAtChainId: '84532',
      assertedAtKav10Address: `0x${'44'.repeat(20)}`,
      reservedKaId: reservedKaId.toString(),
      assertionFinalizedAt: issuedAt.replace('Z', '.000Z'),
      contentScopeVersion: '2',
      kaUal: `did:dkg:base:84532/${canonicalAddress}/7`,
      assertionVersion: '1',
      publicTripleCount: String(prepared.quads.length),
      privateTripleCount: '0',
      privateMerkleRoot: null,
    }) as CanonicalGraphScopedAuthorSealV1,
    issuedAt,
    validUntil: new Date(Date.parse(issuedAt) + 24 * 60 * 60 * 1000)
      .toISOString().replace('.000Z', 'Z'),
    projectionSchemaDigest: SCHEMA_DIGEST,
  });
}

async function signHeadEnvelope(
  object: AgentProfileHeadObjectV1,
  peerSigner: SystemRecordPeerSignerV1,
  evmSigner: EvmPersonalMessageSignerV1,
): Promise<SignedAgentProfileHeadEnvelopeV1> {
  const objectDigest = computeAgentProfileHeadObjectDigestV1(object);
  const [peerSignature, evmSignature] = await Promise.all([
    peerSigner.sign(buildSystemRecordSignatureMessageV1(object, objectDigest, 'peer')),
    evmSigner.signMessage(buildSystemRecordSignatureMessageV1(object, objectDigest, 'current-evm')),
  ]);
  return Object.freeze({
    object,
    objectDigest,
    signatures: Object.freeze([
      Object.freeze({
        role: 'peer' as const,
        suite: 'ed25519-v1' as const,
        signer: peerSigner.peerId,
        evidence: Object.freeze({ kind: 'none' as const }),
        signature: Buffer.from(peerSignature).toString('base64url'),
      }),
      Object.freeze({
        role: 'current-evm' as const,
        suite: 'eip191-personal-sign-digest-v1' as const,
        signer: evmSigner.address,
        evidence: Object.freeze({ kind: 'none' as const }),
        signature: evmSignature,
      }),
    ]),
  });
}

async function signTransitionEnvelope(
  object: AgentProfileAuthorityTransitionV1,
  peerSigner: SystemRecordPeerSignerV1,
  priorSigner: EvmPersonalMessageSignerV1,
  nextSigner: EvmPersonalMessageSignerV1,
): Promise<SignedAgentProfileAuthorityTransitionEnvelopeV1> {
  const objectDigest = computeAgentProfileAuthorityTransitionDigestV1(object);
  const [peerSignature, priorSignature, nextSignature] = await Promise.all([
    peerSigner.sign(buildSystemRecordSignatureMessageV1(object, objectDigest, 'peer')),
    priorSigner.signMessage(buildSystemRecordSignatureMessageV1(object, objectDigest, 'prior-evm')),
    nextSigner.signMessage(buildSystemRecordSignatureMessageV1(object, objectDigest, 'next-evm')),
  ]);
  return Object.freeze({
    object,
    objectDigest,
    signatures: Object.freeze([
      Object.freeze({
        role: 'peer' as const,
        suite: 'ed25519-v1' as const,
        signer: peerSigner.peerId,
        evidence: Object.freeze({ kind: 'none' as const }),
        signature: Buffer.from(peerSignature).toString('base64url'),
      }),
      Object.freeze({
        role: 'prior-evm' as const,
        suite: 'eip191-personal-sign-digest-v1' as const,
        signer: priorSigner.address,
        evidence: Object.freeze({ kind: 'none' as const }),
        signature: priorSignature,
      }),
      Object.freeze({
        role: 'next-evm' as const,
        suite: 'eip191-personal-sign-digest-v1' as const,
        signer: nextSigner.address,
        evidence: Object.freeze({ kind: 'none' as const }),
        signature: nextSignature,
      }),
    ]),
  });
}

function envelopeArtifact(
  objectKind: 'agent-profile-head' | 'authority-transition',
  envelope: SignedAgentProfileHeadEnvelopeV1 | SignedAgentProfileAuthorityTransitionEnvelopeV1,
): SystemRecordProviderArtifactV1 {
  return Object.freeze({
    objectKind,
    objectDigest: envelope.objectDigest,
    canonicalBytes: canonicalizeSignedSystemRecordEnvelopeV1(envelope),
  });
}

function projectionContentDigest(prepared: PreparedAgentProfileV1): Digest32V1 {
  const quads = [...prepared.quads].sort((left, right) => Buffer.compare(
    tripleContentV10(left.subject, left.predicate, left.object),
    tripleContentV10(right.subject, right.predicate, right.object),
  ));
  const leaves = quads.map((quad) => keccak256(
    tripleContentV10(quad.subject, quad.predicate, quad.object),
  ));
  return `0x${Buffer.from(V10MerkleTree.computeKARoot(
    new V10MerkleTree(leaves).root,
    SENTINEL_NO_PRIVATE_V10,
  )).toString('hex')}` as Digest32V1;
}

function observingStore(
  inner: InMemoryAgentProfilePublicationStoreV1,
  events: string[],
): InMemoryAgentProfilePublicationStoreV1 {
  return Object.freeze({
    snapshot: () => inner.snapshot(),
    resolve: (request, signal) => inner.resolve(request, signal),
    resolveArtifact: (reference) => inner.resolveArtifact(reference),
    async prepareCommit(input) {
      const lease = await inner.prepareCommit(input);
      return Object.freeze({
        commit: async () => {
          events.push('advertise');
          await lease.commit();
        },
        abort: () => lease.abort(),
      });
    },
  });
}

function rootRequest(): SystemRecordRequestHeaderV1 {
  return {
    wireVersion: '1', requestId: '0'.repeat(32), kind: 'agents', networkId: NETWORK,
    operation: 'get-root', payloadBytes: '0',
  };
}

function controlRequest(digest: Digest32V1): SystemRecordRequestHeaderV1 {
  return {
    wireVersion: '1', requestId: '1'.repeat(32), kind: 'agents', networkId: NETWORK,
    operation: 'get-control-object', objectKind: 'agent-profile-head',
    objectDigest: digest, payloadBytes: '0',
  };
}
