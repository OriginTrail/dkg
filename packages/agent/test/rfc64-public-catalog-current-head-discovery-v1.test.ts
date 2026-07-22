import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  DKGNode,
  ProtocolRouter,
  computeControlSignatureVariantDigestHex,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type EvmAddressV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import { snapshotRfc64ExactWireRecordV1 } from '../src/rfc64/catalog-transport-wire-v1-internal.js';
import {
  RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
  RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
  Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1,
  encodeRfc64PublicCatalogCurrentHeadQueryV1,
  parseRfc64PublicCatalogCurrentHeadQueryV1,
  type Rfc64PublicCatalogCurrentHeadQueryV1,
} from '../src/rfc64/public-catalog-current-head-discovery-v1.js';
import {
  Rfc64PublicCatalogServiceV1,
} from '../src/rfc64/public-catalog-service-v1.js';
import {
  openRfc64PersistenceV1,
  type Rfc64PersistenceV1,
} from '../src/rfc64/persistence-v1.js';

const NETWORK_ID = 'otp:20430' as const;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/gate-3-discovery' as const;
const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const DELEGATION_DIGEST = `0x${'72'.repeat(32)}` as Digest32V1;
const POLICY_DIGEST = `0x${'71'.repeat(32)}` as Digest32V1;

const temporaryDirectories: string[] = [];
const nodes: DKGNode[] = [];
const persistences: Rfc64PersistenceV1[] = [];
const services: Rfc64PublicCatalogServiceV1[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    try { await service.close(); } catch {}
  }
  for (const persistence of persistences.splice(0)) {
    try { await persistence.close(); } catch {}
  }
  for (const node of nodes.splice(0)) {
    try { await node.stop(); } catch {}
  }
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

async function startNode(): Promise<DKGNode> {
  const node = new DKGNode({
    listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
    enableMdns: false,
  });
  nodes.push(node);
  await node.start();
  return node;
}

async function connect(from: DKGNode, to: DKGNode): Promise<void> {
  const address = to.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('test node has no TCP multiaddr');
  await from.libp2p.dial(multiaddr(address));
}

async function openPersistence(label: string): Promise<Rfc64PersistenceV1> {
  const path = await mkdtemp(join(tmpdir(), `dkg-rfc64-gate3-${label}-`));
  temporaryDirectories.push(path);
  const persistence = await openRfc64PersistenceV1(path, {
    yieldAfterPurgeBatch: async () => {},
  });
  persistences.push(persistence);
  return persistence;
}

function catalogScope(
  contextGraphId = CONTEXT_GRAPH_ID,
): AuthorCatalogScopeV1 {
  return Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  }) as AuthorCatalogScopeV1;
}

async function stageHead(
  persistence: Rfc64PersistenceV1,
  scope = catalogScope(),
  issuedAt: TimestampMsV1 = '1773900000000' as TimestampMsV1,
) {
  const produced = await produceEmptyAuthorCatalogGenesisV1({
    scope,
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    issuedAt,
    signer: {
      issuer: AUTHOR,
      signDigest: (digest) => AUTHOR_WALLET.signMessage(digest),
    },
  });
  const verified = await Promise.all(produced.stagedObjects.map(async (envelope) => ({
    envelope,
    issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
  })));
  await persistence.controlObjects.stageVerifiedObjects(verified);
  return produced.head;
}

async function produceHeadWithProof(
  scope = catalogScope(),
  issuedAt: TimestampMsV1 = '1773900000000' as TimestampMsV1,
) {
  const produced = await produceEmptyAuthorCatalogGenesisV1({
    scope,
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    issuedAt,
    signer: {
      issuer: AUTHOR,
      signDigest: (digest) => AUTHOR_WALLET.signMessage(digest),
    },
  });
  return Object.freeze({
    head: produced.head,
    issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(produced.head),
  });
}

function acceptPolicy(
  service: Rfc64PublicCatalogServiceV1,
  issuedAt?: TimestampMsV1,
) {
  return service.acceptOpenPolicy({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR,
    issuedAt,
  });
}

function discoveryScope() {
  return Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    subGraphName: null,
    authorAddress: AUTHOR,
    catalogEra: '0',
  }) as const;
}

describe('RFC-64 public catalog current-head discovery v1', () => {
  it('treats an unsorted expected-key declaration as an exact key set', () => {
    expect(snapshotRfc64ExactWireRecordV1(
      { alpha: '1', beta: '2' },
      ['beta', 'alpha'],
    )).toEqual({ alpha: '1', beta: '2' });
  });

  it('discovers and exact-verifies one applied head without staging or scheduling it', async () => {
    const [providerNode, requesterNode, providerPersistence, requesterPersistence] =
      await Promise.all([
        startNode(),
        startNode(),
        openPersistence('provider'),
        openPersistence('requester'),
      ]);
    await connect(requesterNode, providerNode);
    const head = await stageHead(providerPersistence);
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async () =>
      head.objectDigest as Digest32V1);

    const provider = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(providerNode),
      controlObjects: providerPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest },
      transportTimeoutMs: 4_000,
    });
    const requester = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(requesterNode),
      controlObjects: requesterPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
      transportTimeoutMs: 4_000,
    });
    services.push(provider, requester);
    const providerPolicy = acceptPolicy(provider);
    const requesterPolicy = acceptPolicy(requester);
    expect(providerPolicy.policyDigest).toBe(requesterPolicy.policyDigest);
    provider.start();
    requester.start();

    expect(RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1)
      .toBe('/dkg/catalog/1/author-head/current');
    let remotePeerIdReads = 0;
    const discoveryInput = {
      scope: discoveryScope(),
    } as {
      remotePeerId: string;
      scope: ReturnType<typeof discoveryScope>;
    };
    Object.defineProperty(discoveryInput, 'remotePeerId', {
      enumerable: true,
      get() {
        remotePeerIdReads += 1;
        return remotePeerIdReads === 1 ? providerNode.peerId : requesterNode.peerId;
      },
    });
    const result = await requester.discoverCurrentCatalogHead(discoveryInput);

    expect(result?.announcement).toEqual({
      kind: 'rfc64-author-catalog-head-availability-v1',
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0',
      catalogVersion: '0',
      policyDigest: requesterPolicy.policyDigest,
      catalogHeadObjectDigest: head.objectDigest,
      signatureVariantDigest: computeControlSignatureVariantDigestHex(
        head.objectDigest,
        head.signature,
      ),
    });
    expect(result?.head.envelope).toEqual(head);
    expect(readCurrentAppliedCatalogHeadDigest).toHaveBeenCalledTimes(2);
    expect(remotePeerIdReads).toBe(1);
    for (const [scope] of readCurrentAppliedCatalogHeadDigest.mock.calls) {
      expect(scope).toEqual(catalogScope());
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(requester.stats().receiver).toMatchObject({
      scheduled: 0,
      applied: 0,
      stagedOnly: 0,
    });
    await expect(requesterPersistence.controlObjects.getVerifiedObject({
      objectDigest: head.objectDigest as Digest32V1,
      signatureVariantDigest: computeControlSignatureVariantDigestHex(
        head.objectDigest,
        head.signature,
      ) as Digest32V1,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })).resolves.toBeNull();
  }, 30_000);

  it('retries once when the applied ref advances while the old immutable head is read', async () => {
    const [providerNode, requesterNode, providerPersistence, requesterPersistence] =
      await Promise.all([
        startNode(),
        startNode(),
        openPersistence('advancing-provider'),
        openPersistence('advancing-requester'),
      ]);
    await connect(requesterNode, providerNode);
    const oldHead = await stageHead(
      providerPersistence,
      catalogScope(),
      '1773900000000' as TimestampMsV1,
    );
    const currentHead = await stageHead(
      providerPersistence,
      catalogScope(),
      '1773900000001' as TimestampMsV1,
    );
    expect(oldHead.objectDigest).not.toBe(currentHead.objectDigest);
    const readCurrentAppliedCatalogHeadDigest = vi.fn()
      .mockResolvedValueOnce(oldHead.objectDigest as Digest32V1)
      .mockResolvedValue(currentHead.objectDigest as Digest32V1);

    const provider = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(providerNode),
      controlObjects: providerPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest },
      transportTimeoutMs: 4_000,
    });
    const requester = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(requesterNode),
      controlObjects: requesterPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
      transportTimeoutMs: 4_000,
    });
    services.push(provider, requester);
    acceptPolicy(provider);
    acceptPolicy(requester);
    provider.start();
    requester.start();

    const result = await requester.discoverCurrentCatalogHead({
      remotePeerId: providerNode.peerId,
      scope: discoveryScope(),
    });

    expect(result?.announcement.catalogHeadObjectDigest).toBe(currentHead.objectDigest);
    expect(result?.head.envelope).toEqual(currentHead);
    expect(readCurrentAppliedCatalogHeadDigest).toHaveBeenCalledTimes(4);
    expect(requester.stats().receiver.scheduled).toBe(0);
  }, 30_000);

  it('returns not-found only after a stable applied-ref snapshot', async () => {
    const [providerNode, requesterNode, providerPersistence, requesterPersistence] =
      await Promise.all([
        startNode(),
        startNode(),
        openPersistence('empty-provider'),
        openPersistence('empty-requester'),
      ]);
    await connect(requesterNode, providerNode);
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async () => null);
    const provider = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(providerNode),
      controlObjects: providerPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest },
      transportTimeoutMs: 4_000,
    });
    const requester = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(requesterNode),
      controlObjects: requesterPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
      transportTimeoutMs: 4_000,
    });
    services.push(provider, requester);
    acceptPolicy(provider);
    acceptPolicy(requester);
    provider.start();
    requester.start();

    await expect(requester.discoverCurrentCatalogHead({
      remotePeerId: providerNode.peerId,
      scope: discoveryScope(),
    })).resolves.toBeNull();
    expect(readCurrentAppliedCatalogHeadDigest).toHaveBeenCalledTimes(2);
    expect(requester.stats().receiver.scheduled).toBe(0);
  }, 20_000);

  it('denies a mismatched policy generation before consulting provider head state', async () => {
    const [providerNode, requesterNode, providerPersistence, requesterPersistence] =
      await Promise.all([
        startNode(),
        startNode(),
        openPersistence('policy-provider'),
        openPersistence('policy-requester'),
      ]);
    await connect(requesterNode, providerNode);
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async () => null);
    const provider = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(providerNode),
      controlObjects: providerPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest },
      transportTimeoutMs: 4_000,
    });
    const requester = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(requesterNode),
      controlObjects: requesterPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
      transportTimeoutMs: 4_000,
    });
    services.push(provider, requester);
    const providerPolicy = acceptPolicy(provider, '1' as TimestampMsV1);
    const requesterPolicy = acceptPolicy(requester, '0' as TimestampMsV1);
    expect(providerPolicy.policyDigest).not.toBe(requesterPolicy.policyDigest);
    provider.start();
    requester.start();

    await expect(requester.discoverCurrentCatalogHead({
      remotePeerId: providerNode.peerId,
      scope: discoveryScope(),
    })).rejects.toMatchObject({ code: 'catalog-discovery-policy-denied' });
    expect(readCurrentAppliedCatalogHeadDigest).not.toHaveBeenCalled();
    expect(requester.stats().receiver.scheduled).toBe(0);
  }, 20_000);

  it('fails closed when an applied-head pointer has no verified control object', async () => {
    const [providerNode, requesterNode, providerPersistence, requesterPersistence] =
      await Promise.all([
        startNode(),
        startNode(),
        openPersistence('dangling-provider'),
        openPersistence('dangling-requester'),
      ]);
    await connect(requesterNode, providerNode);
    const danglingDigest = `0x${'dd'.repeat(32)}` as Digest32V1;
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async () => danglingDigest);
    const provider = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(providerNode),
      controlObjects: providerPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest },
      transportTimeoutMs: 4_000,
    });
    const requester = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(requesterNode),
      controlObjects: requesterPersistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
      transportTimeoutMs: 4_000,
    });
    services.push(provider, requester);
    acceptPolicy(provider);
    acceptPolicy(requester);
    provider.start();
    requester.start();

    await expect(requester.discoverCurrentCatalogHead({
      remotePeerId: providerNode.peerId,
      scope: discoveryScope(),
    })).rejects.toThrow();
    expect(readCurrentAppliedCatalogHeadDigest).toHaveBeenCalled();
    for (const [scope] of readCurrentAppliedCatalogHeadDigest.mock.calls) {
      expect(scope).toEqual(catalogScope());
    }
    expect(requester.stats().receiver.scheduled).toBe(0);
  }, 20_000);

  it('rejects a durable current pointer bound to a different context graph', async () => {
    let handler: ((
      data: Uint8Array,
      peerId: { toString(): string },
      options?: { signal?: AbortSignal },
    ) => Promise<Uint8Array>) | undefined;
    const wrongContextGraphId =
      '0x1111111111111111111111111111111111111111/other-graph' as const;
    const stored = await produceHeadWithProof(catalogScope(wrongContextGraphId));
    const router = {
      register(_protocol: string, registered: typeof handler) {
        handler = registered;
      },
      unregister() {},
    } as unknown as ProtocolRouter;
    const transport = new Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1(router, {
      controlObjects: {
        getVerifiedObjectByDigest: vi.fn(async () => ({
          envelope: stored.head,
          issuerSignature: stored.issuerSignature,
        })),
      },
      readCurrentAppliedCatalogHeadDigest: vi.fn(async () =>
        stored.head.objectDigest as Digest32V1),
      authorizeOpenCatalogOperation: vi.fn(async () => ({
        accessPolicy: 0 as const,
        policyDigest: POLICY_DIGEST,
      })),
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    transport.start();
    const query = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      ...discoveryScope(),
      policyDigest: POLICY_DIGEST,
    }) satisfies Rfc64PublicCatalogCurrentHeadQueryV1;

    await expect(handler!(
      encodeRfc64PublicCatalogCurrentHeadQueryV1(query),
      { toString: () => 'requester-peer' },
    )).rejects.toMatchObject({ code: 'catalog-discovery-object-mismatch' });
    transport.stop();
  });

  it('rejects an issuer proof minted for a different head envelope', async () => {
    let handler: ((
      data: Uint8Array,
      peerId: { toString(): string },
      options?: { signal?: AbortSignal },
    ) => Promise<Uint8Array>) | undefined;
    const stored = await produceHeadWithProof(
      catalogScope(),
      '1773900000000' as TimestampMsV1,
    );
    const other = await produceHeadWithProof(
      catalogScope(),
      '1773900000001' as TimestampMsV1,
    );
    const router = {
      register(_protocol: string, registered: typeof handler) {
        handler = registered;
      },
      unregister() {},
    } as unknown as ProtocolRouter;
    const transport = new Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1(router, {
      controlObjects: {
        getVerifiedObjectByDigest: vi.fn(async () => ({
          envelope: stored.head,
          issuerSignature: other.issuerSignature,
        })),
      },
      readCurrentAppliedCatalogHeadDigest: vi.fn(async () =>
        stored.head.objectDigest as Digest32V1),
      authorizeOpenCatalogOperation: vi.fn(async () => ({
        accessPolicy: 0 as const,
        policyDigest: POLICY_DIGEST,
      })),
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    transport.start();
    const query = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      ...discoveryScope(),
      policyDigest: POLICY_DIGEST,
    }) satisfies Rfc64PublicCatalogCurrentHeadQueryV1;

    await expect(handler!(
      encodeRfc64PublicCatalogCurrentHeadQueryV1(query),
      { toString: () => 'requester-peer' },
    )).rejects.toMatchObject({ code: 'catalog-discovery-signature' });
    transport.stop();
  });

  it('rechecks outbound policy after the awaited remote response', async () => {
    const authorizeOpenCatalogOperation = vi.fn()
      .mockResolvedValueOnce({ accessPolicy: 0 as const, policyDigest: POLICY_DIGEST })
      .mockResolvedValueOnce(null);
    const send = vi.fn(async () => Uint8Array.of(0));
    const router = {
      register() {},
      unregister() {},
      send,
    } as unknown as ProtocolRouter;
    const transport = new Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1(router, {
      controlObjects: { getVerifiedObjectByDigest: vi.fn(async () => null) },
      readCurrentAppliedCatalogHeadDigest: vi.fn(async () => null),
      authorizeOpenCatalogOperation,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    transport.start();
    const query = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      ...discoveryScope(),
      policyDigest: POLICY_DIGEST,
    }) satisfies Rfc64PublicCatalogCurrentHeadQueryV1;

    await expect(transport.discoverCurrentCatalogHead('provider-peer', query))
      .rejects.toMatchObject({ code: 'catalog-discovery-policy-denied' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(authorizeOpenCatalogOperation).toHaveBeenCalledTimes(2);
    transport.stop();
  });

  it('returns denied when inbound policy changes after awaited state reads', async () => {
    let handler: ((
      data: Uint8Array,
      peerId: { toString(): string },
      options?: { signal?: AbortSignal },
    ) => Promise<Uint8Array>) | undefined;
    const authorizeOpenCatalogOperation = vi.fn()
      .mockResolvedValueOnce({ accessPolicy: 0 as const, policyDigest: POLICY_DIGEST })
      .mockResolvedValueOnce(null);
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async () => null);
    const router = {
      register(_protocol: string, registered: typeof handler) {
        handler = registered;
      },
      unregister() {},
    } as unknown as ProtocolRouter;
    const transport = new Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1(router, {
      controlObjects: { getVerifiedObjectByDigest: vi.fn(async () => null) },
      readCurrentAppliedCatalogHeadDigest,
      authorizeOpenCatalogOperation,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    transport.start();
    const query = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      ...discoveryScope(),
      policyDigest: POLICY_DIGEST,
    }) satisfies Rfc64PublicCatalogCurrentHeadQueryV1;

    await expect(handler!(
      encodeRfc64PublicCatalogCurrentHeadQueryV1(query),
      { toString: () => 'requester-peer' },
    )).resolves.toEqual(Uint8Array.of(2));
    expect(readCurrentAppliedCatalogHeadDigest).toHaveBeenCalledTimes(2);
    expect(authorizeOpenCatalogOperation).toHaveBeenCalledTimes(2);
    transport.stop();
  });

  it('rejects a non-root discovery claim through the shared public scope derivation', async () => {
    const [node, persistence] = await Promise.all([
      startNode(),
      openPersistence('scope-derivation'),
    ]);
    const service = new Rfc64PublicCatalogServiceV1({
      router: new ProtocolRouter(node),
      controlObjects: persistence.controlObjects,
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
      transportTimeoutMs: 1_000,
    });
    services.push(service);
    acceptPolicy(service);
    service.start();

    await expect(service.discoverCurrentCatalogHead({
      remotePeerId: 'unreachable-peer',
      scope: Object.freeze({ ...discoveryScope(), subGraphName: 'nested' as const }),
    })).rejects.toThrow(/accepted public\/open root policy/);
  });

  it('round-trips only exact canonical query fields', () => {
    const query = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      ...discoveryScope(),
      policyDigest: POLICY_DIGEST,
    }) satisfies Rfc64PublicCatalogCurrentHeadQueryV1;
    const encoded = encodeRfc64PublicCatalogCurrentHeadQueryV1(query);
    expect(parseRfc64PublicCatalogCurrentHeadQueryV1(encoded)).toEqual(query);

    const parsed = JSON.parse(new TextDecoder().decode(encoded));
    const noncanonical = new TextEncoder().encode(JSON.stringify(
      Object.fromEntries(Object.entries(parsed).reverse()),
    ));
    expect(() => parseRfc64PublicCatalogCurrentHeadQueryV1(noncanonical))
      .toThrow(/canonical JCS/);

    const withUnknown = new TextEncoder().encode(JSON.stringify({ ...parsed, surprise: 'x' }));
    expect(() => parseRfc64PublicCatalogCurrentHeadQueryV1(withUnknown))
      .toThrow(/missing or unknown fields/);
  });

  it('snapshots switching Proxies and rejects accessors without invoking them', () => {
    const query = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      ...discoveryScope(),
      policyDigest: POLICY_DIGEST,
    }) satisfies Rfc64PublicCatalogCurrentHeadQueryV1;
    const expected = encodeRfc64PublicCatalogCurrentHeadQueryV1(query);
    let switchedReads = 0;
    const switching = new Proxy({ ...query }, {
      get(target, property, receiver) {
        if (property === 'networkId') {
          switchedReads += 1;
          return switchedReads === 1 ? NETWORK_ID : '';
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(encodeRfc64PublicCatalogCurrentHeadQueryV1(switching)).toEqual(expected);
    expect(switchedReads).toBe(0);

    let accessorCalls = 0;
    const accessorQuery = { ...query } as Record<string, unknown>;
    Object.defineProperty(accessorQuery, 'networkId', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return NETWORK_ID;
      },
    });
    expect(() => encodeRfc64PublicCatalogCurrentHeadQueryV1(
      accessorQuery as unknown as Rfc64PublicCatalogCurrentHeadQueryV1,
    )).toThrow(/enumerable data properties/);
    expect(accessorCalls).toBe(0);
  });

  it('honors the router stream abort before authorization or applied-head work', async () => {
    let handler: ((
      data: Uint8Array,
      peerId: { toString(): string },
      options: { signal?: AbortSignal },
    ) => Promise<Uint8Array>) | undefined;
    const router = {
      register(_protocol: string, registered: typeof handler) {
        handler = registered;
      },
      unregister() {},
    } as unknown as ProtocolRouter;
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async () => null);
    const authorizeOpenCatalogOperation = vi.fn(async () => ({
      accessPolicy: 0 as const,
      policyDigest: POLICY_DIGEST,
    }));
    const transport = new Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1(router, {
      controlObjects: {
        getVerifiedObjectByDigest: vi.fn(async () => null),
      },
      readCurrentAppliedCatalogHeadDigest,
      authorizeOpenCatalogOperation,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    transport.start();
    const query = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      ...discoveryScope(),
      policyDigest: POLICY_DIGEST,
    }) satisfies Rfc64PublicCatalogCurrentHeadQueryV1;
    const controller = new AbortController();
    const reason = new Error('test stream closed');
    controller.abort(reason);

    await expect(handler!(
      encodeRfc64PublicCatalogCurrentHeadQueryV1(query),
      { toString: () => 'test-peer' },
      { signal: controller.signal },
    )).rejects.toBe(reason);
    expect(authorizeOpenCatalogOperation).not.toHaveBeenCalled();
    expect(readCurrentAppliedCatalogHeadDigest).not.toHaveBeenCalled();
    transport.stop();
  });
});
