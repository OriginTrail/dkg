import {
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileHeadObjectV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { ethers } from 'ethers';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createEvmPersonalMessageSignerV1 } from '../src/evm-message-signer-v1.js';
import {
  type AgentProfileProducerPublicationCommitV1,
  type AgentProfileProducerPublicationStoreV1,
} from '../src/system-records/agent-profile-producer-v1.js';
import { createInMemoryAgentProfilePublicationStoreV1 } from '../src/system-records/in-memory-agent-profile-publication-store-v1.js';
import {
  systemRecordArtifactKeyV1,
  type SystemRecordArtifactV1,
} from '../src/system-records/artifact-v1.js';
import {
  DEPLOYMENT,
  NETWORK,
  OTHER_PRIVATE_KEY,
  createFixtureAgentProfileProducerV1 as createAgentProfileProducerV1,
  envelopeArtifact,
  makePrepared,
  produce,
  producerFixture,
  publicationFor,
  signHeadEnvelope,
  signTransitionEnvelope,
} from './support/agent-profile-producer-v1-fixture.js';


describe('agent-profile system-record producer V1 authority and lineage', () => {
  it('rejects an ordinary update over a signed tombstone before install or commit', async () => {
    const fixture = await producerFixture();
    const initialProducer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store: fixture.store,
      fence: () => {},
      install: () => {},
    });
    await produce(initialProducer, fixture.prepared, fixture.publication);
    const activeEnvelope = fixture.store.snapshot().currentHead!;
    const active = activeEnvelope.object;
    const tombstone = {
      objectType: 'agent-profile-head',
      kind: 'agents',
      state: 'tombstone',
      networkId: active.networkId,
      peerId: active.peerId,
      peerPublicKey: active.peerPublicKey,
      authoritySequence: active.authoritySequence,
      version: '1',
      previousHeadDigest: activeEnvelope.objectDigest,
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
    const prepareCommit = vi.fn(fixture.store.prepareCommit.bind(fixture.store));
    const store: AgentProfileProducerPublicationStoreV1 = {
      snapshot: () => {
        const snapshot = fixture.store.snapshot();
        return Object.freeze({ ...snapshot, currentHead: tombstoneEnvelope });
      },
      resolveArtifact: (reference) => fixture.store.resolveArtifact(reference),
      prepareCommit,
    };
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: fixture.peerSigner,
      evmSigner: fixture.evmSigner,
      store,
      fence: () => {},
      install,
    });
    const nextPrepared = makePrepared(
      fixture.peerSigner,
      fixture.evmSigner.address,
      '2026-08-07T12:20:00.000Z',
    );
    const lease = await producer.prepare(nextPrepared);

    await expect(lease.complete(await publicationFor(
      nextPrepared,
      fixture.evmSigner.address,
      '2026-08-07T12:20:00Z',
    ))).rejects.toThrow(/tombstoned profile/);
    expect(install).not.toHaveBeenCalled();
    expect(prepareCommit).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead?.objectDigest).toBe(activeEnvelope.objectDigest);
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
    const history = new Map<string, SystemRecordArtifactV1>();
    for (const artifact of [
      envelopeArtifact('agent-profile-head', priorEnvelope),
      envelopeArtifact('authority-transition', transitionEnvelope),
    ]) {
      history.set(systemRecordArtifactKeyV1(artifact), artifact);
    }
    let pendingCommit: AgentProfileProducerPublicationCommitV1 | null = null;
    const store: AgentProfileProducerPublicationStoreV1 = {
      snapshot: () => Object.freeze({ inventory: null, currentHead: transitionedEnvelope }),
      resolveArtifact: (reference) => history.get(systemRecordArtifactKeyV1(reference)) ?? null,
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
    const headArtifact = pendingCommit!.publicationArtifacts.head;
    const heartbeatEnvelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(
      headArtifact.canonicalBytes,
    );
    expect(result).toMatchObject({ authoritySequence: '1', version: '1' });
    expect(heartbeatEnvelope.object.acceptedTransitionDigest)
      .toBe(transitionEnvelope.objectDigest);
    expect(heartbeatEnvelope.object.previousHeadDigest).toBe(transitionedEnvelope.objectDigest);
  });

});
