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
} from '../src/system-records/provider-v1.js';
import {
  DEPLOYMENT,
  NETWORK,
  OTHER_PRIVATE_KEY,
  controlRequest,
  envelopeArtifact,
  makePrepared,
  observingStore,
  produce,
  producerFixture,
  publicationFor,
  rootRequest,
  signHeadEnvelope,
  signTransitionEnvelope,
} from './support/agent-profile-producer-v1-fixture.js';

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
    const inventoryObject = snapshot.inventory?.objects.get(snapshot.inventory.descriptor.treeRootDigest);
    expect(inventoryObject).toBeDefined();
    if (inventoryObject === undefined) throw new Error('published inventory object is missing');
    await expect(store.resolve({
      type: 'object', rootDescriptorDigest: `0x${'ff'.repeat(32)}`,
      objectKind: inventoryObject.objectKind, objectDigest: inventoryObject.objectDigest,
    }, new AbortController().signal)).resolves.toBeNull();
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

  it('rolls back when the peer signer returns an invalid profile-head signature', async () => {
    const fixture = await producerFixture();
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: { ...fixture.peerSigner, sign: async () => new Uint8Array(64) },
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install,
    });

    await expect(produce(producer, fixture.prepared, fixture.publication))
      .rejects.toThrow(/head signature verification failed/);
    expect(install).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it('rolls back when the peer signer returns an invalid inventory-root signature', async () => {
    const fixture = await producerFixture();
    const install = vi.fn();
    let signatureNumber = 0;
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: {
        ...fixture.peerSigner,
        sign: async (message) => {
          signatureNumber += 1;
          return signatureNumber === 1
            ? fixture.peerSigner.sign(message)
            : new Uint8Array(64);
        },
      },
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install,
    });

    await expect(produce(producer, fixture.prepared, fixture.publication))
      .rejects.toThrow(/inventory root signature verification failed/);
    expect(install).not.toHaveBeenCalled();
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

  it('rejects an out-of-schema profile predicate before fencing publication', async () => {
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
    const outOfSchema = Object.freeze({
      ...fixture.prepared,
      quads: Object.freeze([
        ...fixture.prepared.quads,
        Object.freeze({
          subject: fixture.prepared.rootEntity,
          predicate: 'https://example.org/unapproved',
          object: '"x"',
          graph: fixture.prepared.quads[0]!.graph,
        }),
      ]),
    });

    await expect(producer.prepare(outOfSchema)).rejects.toThrow(/outside schema V1/);
    expect(fence).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'a literal profile link',
      mutate: (prepared: PreparedAgentProfileV1) => prepared.quads.map((quad) => (
        quad.predicate === 'http://www.w3.org/ns/prov#wasGeneratedBy'
          ? { ...quad, object: '"not-an-iri"' }
          : quad
      )),
    },
    {
      label: 'an unapproved rdf:type object',
      mutate: (prepared: PreparedAgentProfileV1) => prepared.quads.map((quad) => (
        quad.subject === prepared.rootEntity
          && quad.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
          && quad.object === 'https://dkg.network/ontology#Agent'
          ? { ...quad, object: 'https://example.org/InvalidAgentType' }
          : quad
      )),
    },
    {
      label: 'an underived x25519 revocation subject',
      mutate: (prepared: PreparedAgentProfileV1) => [
        ...prepared.quads,
        {
          subject: prepared.rootEntity,
          predicate: 'https://dkg.network/ontology#publicEncryptionKey',
          object: `"${Buffer.alloc(32, 9).toString('base64url')}"`,
          graph: prepared.quads[0]!.graph,
        },
        {
          subject: `${prepared.rootEntity}#x25519-${'0'.repeat(32)}`,
          predicate: 'https://dkg.network/ontology#revokedAt',
          object: '"2026-08-07T12:00:00Z"',
          graph: prepared.quads[0]!.graph,
        },
      ],
    },
  ])('rejects $label before fencing publication', async ({ mutate }) => {
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
    const malformed = Object.freeze({
      ...fixture.prepared,
      quads: Object.freeze(mutate(fixture.prepared)),
    });

    await expect(producer.prepare(malformed)).rejects.toThrow(/outside schema V1/);
    expect(fence).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
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
