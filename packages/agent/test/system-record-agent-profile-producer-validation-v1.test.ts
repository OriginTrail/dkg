import { SYSTEM_RECORD_MAX_CLOCK_SKEW_MS } from '@origintrail-official/dkg-core/system-record-v1';
import { ethers } from 'ethers';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { prepareAgentProfileV1 } from '../src/profile.js';
import {
  type AgentProfileProducerPublicationStoreV1,
  type AgentProfilePublicationBindingV1,
} from '../src/system-records/agent-profile-producer-v1.js';
import { createInMemoryAgentProfilePublicationStoreV1 } from '../src/system-records/in-memory-agent-profile-publication-store-v1.js';
import {
  DEPLOYMENT,
  NETWORK,
  OTHER_PRIVATE_KEY,
  createFixtureAgentProfileProducerV1 as createAgentProfileProducerV1,
  makePrepared,
  produce,
  producerFixture,
  publicationFor,
} from './support/agent-profile-producer-v1-fixture.js';


describe('agent-profile system-record producer V1 validation and binding', () => {
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
      publicationQuads: fixture.prepared.publicationQuads.map((quad) => ({ ...quad })),
      projectionQuads: fixture.prepared.projectionQuads.map((quad) => ({ ...quad })),
      rootEntity: fixture.prepared.rootEntity,
      lastSeen: fixture.prepared.lastSeen,
    };

    const lease = await producer.prepare(mutable);
    mutable.publicationQuads.length = 0;
    mutable.projectionQuads.length = 0;
    mutable.rootEntity = 'urn:mutated-after-prepare';
    await expect(lease.complete(fixture.publication)).resolves.toMatchObject({ version: '0' });
    expect(fence).toHaveBeenCalledWith(
      expect.objectContaining({ rootEntity: fixture.prepared.rootEntity }),
      expect.any(AbortSignal),
    );
    expect(fixture.store.snapshot().currentHead?.object.rootSubject)
      .toBe(fixture.prepared.rootEntity);
  });

  it('defensively snapshots the publication binding across later signing awaits', async () => {
    const fixture = await producerFixture();
    const originalFinalizedAt = fixture.publication.seal.assertionFinalizedAt;
    const mutableSeal = { ...fixture.publication.seal };
    const mutablePublication = {
      ...fixture.publication,
      seal: mutableSeal,
    } as AgentProfilePublicationBindingV1;
    let peerSignatureCount = 0;
    const peerSign = vi.fn(async (message: Uint8Array) => {
      peerSignatureCount += 1;
      if (peerSignatureCount === 2) {
        mutableSeal.assertionFinalizedAt = '2026-08-07T12:15:00.000Z';
      }
      return fixture.peerSigner.sign(message);
    });
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

    await expect(produce(producer, fixture.prepared, mutablePublication))
      .resolves.toMatchObject({ version: '0' });
    expect(mutableSeal.assertionFinalizedAt).not.toBe(originalFinalizedAt);
    expect(install.mock.calls[0]![0].head.graphScopedAuthorSeal.assertionFinalizedAt)
      .toBe(originalFinalizedAt);
    expect(fixture.store.snapshot().currentHead?.object.graphScopedAuthorSeal.assertionFinalizedAt)
      .toBe(originalFinalizedAt);
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

  it('rejects a non-confirmed publication before installation', async () => {
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
    const publication: AgentProfilePublicationBindingV1 = {
      ...fixture.publication,
      publicationStatus: 'tentative',
    };

    await expect(produce(producer, fixture.prepared, publication))
      .rejects.toThrow(/requires a confirmed publication/);
    expect(install).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it.each([
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

  it('rejects a head issue time before assertion finalization without side effects', async () => {
    const fixture = await producerFixture();
    const peerSign = vi.fn(fixture.peerSigner.sign);
    const evmSignMessage = vi.fn(fixture.evmSigner.signMessage);
    const prepareCommit = vi.fn(fixture.store.prepareCommit.bind(fixture.store));
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: { ...fixture.peerSigner, sign: peerSign },
      evmSigner: { ...fixture.evmSigner, signMessage: evmSignMessage },
      store: {
        snapshot: () => fixture.store.snapshot(),
        resolveArtifact: (reference) => fixture.store.resolveArtifact(reference),
        prepareCommit,
      },
      fence: () => {},
      install,
    });

    await expect(produce(producer, fixture.prepared, {
      ...fixture.publication,
      seal: {
        ...fixture.publication.seal,
        assertionFinalizedAt: '2026-08-07T13:00:00.000Z',
      },
    })).rejects.toThrow(/issuedAt predates assertion finalization/);
    expect(peerSign).not.toHaveBeenCalled();
    expect(evmSignMessage).not.toHaveBeenCalled();
    expect(prepareCommit).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it('preserves millisecond finalization precision in the issue-time ordering check', async () => {
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
    const finalizedWithinSecond = {
      ...fixture.publication,
      seal: {
        ...fixture.publication.seal,
        assertionFinalizedAt: '2026-08-07T12:00:00.999Z',
      },
    } as AgentProfilePublicationBindingV1;

    await expect(produce(producer, fixture.prepared, finalizedWithinSecond))
      .rejects.toThrow(/issuedAt predates assertion finalization/);
    expect(peerSign).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();

    await expect(produce(producer, fixture.prepared, {
      ...finalizedWithinSecond,
      issuedAt: '2026-08-07T12:00:01Z',
    })).resolves.toMatchObject({ version: '0' });
    expect(install).toHaveBeenCalledOnce();
    expect(fixture.store.snapshot().currentHead?.object.issuedAt).toBe('2026-08-07T12:00:01Z');
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
      'a foreign UAL account',
      (publication: AgentProfilePublicationBindingV1) => ({
        ...publication,
        seal: {
          ...publication.seal,
          kaUal: publication.seal.kaUal.replace(
            /\/0x[0-9a-f]{40}\//,
            `/0x${'22'.repeat(20)}/`,
          ),
        },
      }),
    ],
    [
      'a foreign asserted chain',
      (publication: AgentProfilePublicationBindingV1) => ({
        ...publication,
        seal: { ...publication.seal, assertedAtChainId: '1' },
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

  it('rejects an already-expired validity window before signing, install, or commit', async () => {
    const fixture = await producerFixture();
    const peerSign = vi.fn(fixture.peerSigner.sign);
    const evmSignMessage = vi.fn(fixture.evmSigner.signMessage);
    const prepareCommit = vi.fn(fixture.store.prepareCommit.bind(fixture.store));
    const store: AgentProfileProducerPublicationStoreV1 = {
      snapshot: () => fixture.store.snapshot(),
      resolveArtifact: (reference) => fixture.store.resolveArtifact(reference),
      prepareCommit,
    };
    const install = vi.fn();
    const nowMs = Date.parse('2026-08-07T12:00:00Z');
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: { ...fixture.peerSigner, sign: peerSign },
      evmSigner: { ...fixture.evmSigner, signMessage: evmSignMessage },
      store,
      nowMs: () => nowMs,
      fence: () => {},
      install,
    });

    await expect(produce(producer, fixture.prepared, {
      ...fixture.publication,
      issuedAt: '2026-08-06T00:00:00Z',
      validUntil: '2026-08-06T01:00:00Z',
      seal: {
        ...fixture.publication.seal,
        assertionFinalizedAt: '2026-08-06T00:00:00.000Z',
      },
    })).rejects.toThrow(/already expired/);
    expect(peerSign).not.toHaveBeenCalled();
    expect(evmSignMessage).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(prepareCommit).not.toHaveBeenCalled();
    expect(fixture.store.snapshot().currentHead).toBeNull();
  });

  it('rejects an oversized encoded profile bundle before signing, install, or commit', async () => {
    const fixture = await producerFixture();
    const multiaddrs = Array.from({ length: 6_000 }, (_, index) => (
      `/dns4/profile-${index.toString().padStart(4, '0')}-${'a'.repeat(96)}.example/tcp/4001`
    ));
    const prepared = prepareAgentProfileV1({
      peerId: fixture.peerSigner.peerId,
      publicKey: Buffer.from(fixture.peerSigner.publicKey, 'base64url').toString('base64'),
      agentAddress: fixture.evmSigner.address,
      name: 'Oversized profile fixture',
      nodeRole: 'edge',
      lastSeen: '2026-08-07T12:00:00.000Z',
      skills: [],
      multiaddrs,
    });
    const peerSign = vi.fn(fixture.peerSigner.sign);
    const evmSignMessage = vi.fn(fixture.evmSigner.signMessage);
    const prepareCommit = vi.fn(fixture.store.prepareCommit.bind(fixture.store));
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
      publicationDeployment: DEPLOYMENT,
      peerSigner: { ...fixture.peerSigner, sign: peerSign },
      evmSigner: { ...fixture.evmSigner, signMessage: evmSignMessage },
      store: {
        snapshot: () => fixture.store.snapshot(),
        resolveArtifact: (reference) => fixture.store.resolveArtifact(reference),
        prepareCommit,
      },
      fence: () => {},
      install,
    });

    await expect(produce(
      producer,
      prepared,
      await publicationFor(prepared, fixture.evmSigner.address, '2026-08-07T12:00:00Z'),
    )).rejects.toThrow(/profile bundle exceeds/);
    expect(peerSign).not.toHaveBeenCalled();
    expect(evmSignMessage).not.toHaveBeenCalled();
    expect(prepareCommit).not.toHaveBeenCalled();
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

});
