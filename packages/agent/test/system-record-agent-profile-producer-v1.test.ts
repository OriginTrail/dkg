import { ed25519 } from '@noble/curves/ed25519.js';
import {
  SENTINEL_NO_PRIVATE_V10,
  V10MerkleTree,
  keccak256,
  tripleContentV10,
  buildAuthorAttestationTypedData,
  type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';
import {
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  type Digest32V1,
  type SystemRecordPeerPublicKeyV1,
  type SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { createEvmPersonalMessageSignerV1 } from '../src/evm-message-signer-v1.js';
import { prepareAgentProfileV1, type PreparedAgentProfileV1 } from '../src/profile.js';
import {
  createAgentProfileProducerV1,
  type AgentProfileProducerPublicationStoreV1,
  type AgentProfileProducerV1,
  type AgentProfilePublicationBindingV1,
  type SystemRecordPeerSignerV1,
} from '../src/system-records/agent-profile-producer-v1.js';
import { createInMemoryAgentProfilePublicationStoreV1 } from '../src/system-records/in-memory-agent-profile-publication-store-v1.js';

const NETWORK = 'base:84532' as const;
const SCHEMA_DIGEST = `0x${'ab'.repeat(32)}` as Digest32V1;
const PRIVATE_KEY = `0x${'11'.repeat(32)}`;

describe('agent-profile system-record producer V1', () => {
  it('stages one exact profile, installs it, then advertises the signed inventory root', async () => {
    const fixture = await producerFixture();
    const events: string[] = [];
    const store = observingStore(fixture.store, events);
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
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

  it('preflights provider capacity before materialization and releases a failed commit lease', async () => {
    const fixture = await producerFixture(createInMemoryAgentProfilePublicationStoreV1({
      maxObjects: 1,
      maxBytes: 1024 * 1024,
    }));
    const install = vi.fn();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
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

  it('fails closed when the publication seal is not for the exact prepared bytes', async () => {
    const fixture = await producerFixture();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
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

  it('rejects a seal whose author attestation does not recover the profile authority', async () => {
    const fixture = await producerFixture();
    const producer = createAgentProfileProducerV1({
      networkId: NETWORK,
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
    address: new ethers.Wallet(PRIVATE_KEY).address,
    custodialPrivateKey: PRIVATE_KEY,
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
  const signature = ethers.Signature.from(await new ethers.Wallet(PRIVATE_KEY).signTypedData(
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
  inner: AgentProfileProducerPublicationStoreV1,
  events: string[],
): AgentProfileProducerPublicationStoreV1 {
  return Object.freeze({
    snapshot: () => inner.snapshot(),
    resolve: (request, signal) => inner.resolve(request, signal),
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
