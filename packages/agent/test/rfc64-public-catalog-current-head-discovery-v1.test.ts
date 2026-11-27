import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  DKGNode,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  ProtocolRouter,
  computeControlSignatureVariantDigestHex,
  type AuthorCatalogScopeV1,
  type ContextGraphPolicyV1,
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
  RFC64_PRIVATE_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V2,
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
  encodeRfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';
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
const GOVERNANCE_CONTRACT =
  '0x5555555555555555555555555555555555555555' as EvmAddressV1;

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

function governedCatalogScope(): AuthorCatalogScopeV1 {
  return Object.freeze({
    ...catalogScope(),
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE_CONTRACT,
    ownershipTransitionDigest: `0x${'57'.repeat(32)}`,
  }) as AuthorCatalogScopeV1;
}

function finalizedPublicPolicy(): ContextGraphPolicyV1 {
  return Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE_CONTRACT,
    ownershipTransitionDigest: `0x${'57'.repeat(32)}`,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'finalized-chain',
      chainId: '20430',
      contractAddress: GOVERNANCE_CONTRACT,
      blockNumber: '123',
      blockHash: `0x${'77'.repeat(32)}`,
    },
    effectiveAt: '1773900000000',
    issuedAt: '1773900000000',
  });
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

function directAuthorization(scope = catalogScope()) {
  return Object.freeze({
    accessPolicy: 0 as const,
    policyDigest: POLICY_DIGEST,
    trustedCatalogScope: scope,
  });
}

describe('RFC-64 public catalog current-head discovery v1', () => {
  it('accepts the deprecated open-authorizer option but rejects ambiguity', () => {
    const router = {
      register() {},
      unregister() {},
    } as unknown as ProtocolRouter;
    const legacy = vi.fn(async () => directAuthorization());
    expect(() => new Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1(router, {
      controlObjects: { getVerifiedObjectByDigest: vi.fn(async () => null) },
      readCurrentAppliedCatalogHeadDigest: vi.fn(async () => null),
      authorizeOpenCatalogOperation: legacy,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })).not.toThrow();
    expect(() => new Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1(router, {
      controlObjects: { getVerifiedObjectByDigest: vi.fn(async () => null) },
      readCurrentAppliedCatalogHeadDigest: vi.fn(async () => null),
      authorizeCatalogOperation: legacy,
      authorizeOpenCatalogOperation: legacy,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })).toThrow(/exactly one catalog access-policy authorizer/u);
  });

  it('routes invite-only discovery to v2 and keeps private queries off the public handler', async () => {
    const handlers = new Map<string, (
      data: Uint8Array,
      peerId: { toString(): string },
    ) => Promise<Uint8Array>>();
    const send = vi.fn(async () => Uint8Array.of(0));
    const router = {
      register(protocol: string, handler: (typeof handlers extends Map<string, infer H> ? H : never)) {
        handlers.set(protocol, handler);
      },
      unregister(protocol: string) { handlers.delete(protocol); },
      send,
    } as unknown as ProtocolRouter;
    const authorizeCatalogOperation = vi.fn(async () => Object.freeze({
      ...directAuthorization(),
      accessPolicy: 1 as const,
    }));
    const transport = new Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1(router, {
      controlObjects: { getVerifiedObjectByDigest: vi.fn(async () => null) },
      readCurrentAppliedCatalogHeadDigest: vi.fn(async () => null),
      authorizeCatalogOperation,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    transport.start();
    const query = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      ...discoveryScope(),
      policyDigest: POLICY_DIGEST,
    }) satisfies Rfc64PublicCatalogCurrentHeadQueryV1;

    await expect(transport.discoverCurrentCatalogHead('provider-peer', query))
      .resolves.toBeNull();
    expect(send).toHaveBeenCalledWith(
      'provider-peer',
      RFC64_PRIVATE_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V2,
      expect.any(Uint8Array),
      undefined,
    );
    await expect(handlers.get(RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1)!(
      encodeRfc64PublicCatalogCurrentHeadQueryV1(query),
      { toString: () => 'requester-peer' },
    )).resolves.toEqual(Uint8Array.of(2));
    expect(authorizeCatalogOperation).toHaveBeenCalled();
    transport.stop();
  });

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

  it('preserves the finalized public governance scope during current-head discovery', async () => {
    const [providerNode, requesterNode, providerPersistence, requesterPersistence] =
      await Promise.all([
        startNode(),
        startNode(),
        openPersistence('governed-provider'),
        openPersistence('governed-requester'),
      ]);
    await connect(requesterNode, providerNode);
    const expectedScope = governedCatalogScope();
    const head = await stageHead(providerPersistence, expectedScope);
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async (
      trustedScope: Readonly<AuthorCatalogScopeV1>,
    ) => {
      expect(trustedScope).toEqual(expectedScope);
      return head.objectDigest as Digest32V1;
    });
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
    for (const service of [provider, requester]) {
      service.acceptPolicySnapshot({
        policy: finalizedPublicPolicy(),
        policyDigest: POLICY_DIGEST,
      });
      service.start();
    }

    await expect(requester.discoverCurrentCatalogHead({
      remotePeerId: providerNode.peerId,
      scope: discoveryScope(),
    })).resolves.toMatchObject({
      head: { envelope: { objectDigest: head.objectDigest } },
    });
    expect(readCurrentAppliedCatalogHeadDigest).toHaveBeenCalledTimes(2);
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

  it('reports denial when provider policy changes after initial authorization', async () => {
    const [providerNode, requesterNode, providerPersistence, requesterPersistence] =
      await Promise.all([
        startNode(),
        startNode(),
        openPersistence('revoked-provider'),
        openPersistence('revoked-requester'),
      ]);
    await connect(requesterNode, providerNode);
    let provider!: Rfc64PublicCatalogServiceV1;
    let providerHeadReads = 0;
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async (
      trustedCatalogScope: Readonly<AuthorCatalogScopeV1>,
    ) => {
      expect(trustedCatalogScope).toEqual(catalogScope());
      providerHeadReads += 1;
      if (providerHeadReads === 1) {
        const current = provider.acceptedPolicySnapshot(NETWORK_ID, CONTEXT_GRAPH_ID)!;
        const successor = Object.freeze({
          ...current.policy,
          version: '1' as const,
          previousPolicyDigest: current.policyDigest,
        });
        const advanced = provider.acceptPolicySnapshot({
          policy: successor,
          policyDigest: `0x${'34'.repeat(32)}` as Digest32V1,
        });
        expect(advanced.policyDigest).not.toBe(current.policyDigest);
      }
      return null;
    });
    provider = new Rfc64PublicCatalogServiceV1({
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
    acceptPolicy(provider, '0' as TimestampMsV1);
    acceptPolicy(requester, '0' as TimestampMsV1);
    provider.start();
    requester.start();

    await expect(requester.discoverCurrentCatalogHead({
      remotePeerId: providerNode.peerId,
      scope: discoveryScope(),
    })).rejects.toMatchObject({ code: 'catalog-discovery-policy-denied' });
    expect(readCurrentAppliedCatalogHeadDigest).toHaveBeenCalledTimes(2);
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
      authorizeCatalogOperation: vi.fn(async () => ({
        ...directAuthorization(),
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
      authorizeCatalogOperation: vi.fn(async () => ({
        ...directAuthorization(),
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
    const authorizeCatalogOperation = vi.fn()
      .mockResolvedValueOnce(directAuthorization())
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
      authorizeCatalogOperation,
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
    expect(authorizeCatalogOperation).toHaveBeenCalledTimes(2);
    transport.stop();
  });

  it('returns denied when inbound policy changes after awaited state reads', async () => {
    let handler: ((
      data: Uint8Array,
      peerId: { toString(): string },
      options?: { signal?: AbortSignal },
    ) => Promise<Uint8Array>) | undefined;
    const authorizeCatalogOperation = vi.fn()
      .mockResolvedValueOnce(directAuthorization())
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
      authorizeCatalogOperation,
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
    expect(authorizeCatalogOperation).toHaveBeenCalledTimes(2);
    transport.stop();
  });

  it('rejects a canonical requester-side response outside the exact query scope', async () => {
    const stored = await produceHeadWithProof();
    const mismatchedAnnouncement = Object.freeze({
      kind: 'rfc64-author-catalog-head-availability-v1' as const,
      ...discoveryScope(),
      subGraphName: 'nested' as const,
      catalogVersion: '0' as const,
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: stored.head.objectDigest as Digest32V1,
      signatureVariantDigest: computeControlSignatureVariantDigestHex(
        stored.head.objectDigest,
        stored.head.signature,
      ) as Digest32V1,
    });
    const payload = encodeRfc64PublicCatalogHeadAnnouncementV1(mismatchedAnnouncement);
    const response = new Uint8Array(payload.byteLength + 1);
    response[0] = 1;
    response.set(payload, 1);
    const router = {
      register() {},
      unregister() {},
      send: vi.fn(async () => response),
    } as unknown as ProtocolRouter;
    const transport = new Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1(router, {
      controlObjects: { getVerifiedObjectByDigest: vi.fn(async () => null) },
      readCurrentAppliedCatalogHeadDigest: vi.fn(async () => null),
      authorizeCatalogOperation: vi.fn(async () => directAuthorization()),
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    transport.start();
    const query = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      ...discoveryScope(),
      policyDigest: POLICY_DIGEST,
    }) satisfies Rfc64PublicCatalogCurrentHeadQueryV1;

    await expect(transport.discoverCurrentCatalogHead('provider-peer', query))
      .rejects.toMatchObject({ code: 'catalog-discovery-object-mismatch' });
    transport.stop();
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
    const authorizeCatalogOperation = vi.fn(async () => ({
      ...directAuthorization(),
    }));
    const transport = new Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1(router, {
      controlObjects: {
        getVerifiedObjectByDigest: vi.fn(async () => null),
      },
      readCurrentAppliedCatalogHeadDigest,
      authorizeCatalogOperation,
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
    expect(authorizeCatalogOperation).not.toHaveBeenCalled();
    expect(readCurrentAppliedCatalogHeadDigest).not.toHaveBeenCalled();
    transport.stop();
  });
});
