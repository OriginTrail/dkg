import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  DKGNode,
  ProtocolRouter,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import {
  type Rfc64CatalogAccessAuthorizationInputV1,
} from '../src/rfc64/catalog-access-policy-v1.js';
import { openRfc64PersistenceV1, type Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
  RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1,
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_PROTOCOL_V1,
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_PROTOCOL_V2,
  Rfc64PublicCatalogTransportV1,
  encodeRfc64PublicCatalogHeadAnnouncementV1,
  encodeRfc64PublicCatalogHeadReplayCompletionV2,
  parseRfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogHeadReplayRequestV1,
  type Rfc64PublicCatalogReplayOverloadRetryV1,
  type Rfc64PublicCatalogTransportOptionsV1,
} from '../src/rfc64/public-catalog-transport-v1.js';
import { createRfc64CatalogAccessPolicyRegistryFixture } from './support/rfc64-catalog-access-policy-fixture.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const POLICY_DIGEST = `0x${'71'.repeat(32)}` as Digest32V1;
const DELEGATION_DIGEST = `0x${'72'.repeat(32)}` as Digest32V1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/gate-1' as const;
const LOCAL_MEMBER = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const REMOTE_MEMBER = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const CURATOR = '0x5555555555555555555555555555555555555555' as EvmAddressV1;

const temporaryDirectories: string[] = [];
const nodes: DKGNode[] = [];
const persistences: Rfc64PersistenceV1[] = [];
const transports: Rfc64PublicCatalogTransportV1[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) transport.stop();
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

async function temporaryDataDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dkg-rfc64-${label}-`));
  temporaryDirectories.push(path);
  return path;
}

async function openPersistence(label: string): Promise<Rfc64PersistenceV1> {
  const persistence = await openRfc64PersistenceV1(
    await temporaryDataDirectory(label),
    { yieldAfterPurgeBatch: async () => {} },
  );
  persistences.push(persistence);
  return persistence;
}

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

async function stageOpenCatalogHead(
  persistence: Rfc64PersistenceV1,
): Promise<Rfc64PublicCatalogHeadAnnouncementV1> {
  const scope = {
    networkId: 'otp:20430',
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: '20430',
    governanceContractAddress: '0x2222222222222222222222222222222222222222',
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  } as AuthorCatalogScopeV1;
  const produced = await produceEmptyAuthorCatalogGenesisV1({
    scope,
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    issuedAt: '1773900000000',
    signer: {
      issuer: AUTHOR,
      signDigest: async (digest) => AUTHOR_WALLET.signMessage(digest),
    },
  });
  const verified = await Promise.all(produced.stagedObjects.map(async (envelope) => ({
    envelope,
    issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
  })));
  const staged = await persistence.controlObjects.stageVerifiedObjects(verified);
  const headKeys = staged.objects.at(-1);
  if (headKeys === undefined) throw new Error('catalog producer staged no head');
  return Object.freeze({
    kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
    networkId: produced.head.payload.networkId,
    contextGraphId: produced.head.payload.contextGraphId,
    subGraphName: produced.head.payload.subGraphName,
    authorAddress: produced.head.payload.authorAddress,
    catalogEra: produced.head.payload.era,
    catalogVersion: produced.head.payload.version,
    policyDigest: POLICY_DIGEST,
    catalogHeadObjectDigest: headKeys.objectDigest,
    signatureVariantDigest: headKeys.signatureVariantDigest,
  });
}

const OPEN_POLICY = async () => Object.freeze({
  accessPolicy: 0 as const,
  policyDigest: POLICY_DIGEST,
});

function policyRegistry(
  localAgentAddress: EvmAddressV1,
  remoteAgentAddress: EvmAddressV1,
  accessPolicy: 0 | 1,
  publishPolicy: 0 | 1,
) {
  return createRfc64CatalogAccessPolicyRegistryFixture({
    localAgentAddress,
    remoteAgentAddress,
    contextGraphId: CONTEXT_GRAPH_ID,
    accessPolicy,
    publishPolicy,
    policyDigest: POLICY_DIGEST,
    ownerAddress: AUTHOR,
    curatorAddress: CURATOR,
  });
}

function replayRequest(): Rfc64PublicCatalogHeadReplayRequestV1 {
  return Object.freeze({
    kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
    networkId: 'otp:20430',
    contextGraphId: CONTEXT_GRAPH_ID,
    policyDigest: POLICY_DIGEST,
  });
}

function requesterTransportForReplay(
  send: ProtocolRouter['send'],
  replayOverloadRetry: Rfc64PublicCatalogReplayOverloadRetryV1,
  authorizeCatalogOperation: NonNullable<
    Rfc64PublicCatalogTransportOptionsV1['authorizeCatalogOperation']
  > = OPEN_POLICY,
): Rfc64PublicCatalogTransportV1 {
  const transport = new Rfc64PublicCatalogTransportV1({
    register: () => {},
    unregister: () => {},
    send,
  } as unknown as ProtocolRouter, {
    controlObjects: { getVerifiedObject: async () => null },
    authorizeCatalogOperation,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    onCatalogHeadAvailable: async () => {},
    replayOverloadRetry,
  });
  transports.push(transport);
  transport.start();
  return transport;
}

describe('RFC-64 author catalog transport v1', () => {
  it.each([
    { accessPolicy: 0 as const, publishPolicy: 0 as const },
    { accessPolicy: 0 as const, publishPolicy: 1 as const },
    { accessPolicy: 1 as const, publishPolicy: 0 as const },
    { accessPolicy: 1 as const, publishPolicy: 1 as const },
  ])(
    'announces and fetches one exact signed head for accessPolicy=$accessPolicy publishPolicy=$publishPolicy',
    async ({ accessPolicy, publishPolicy }) => {
    const [authorNode, receiverNode, authorPersistence, receiverPersistence] = await Promise.all([
      startNode(),
      startNode(),
      openPersistence('author'),
      openPersistence('receiver'),
    ]);
    await connect(receiverNode, authorNode);

    const announcement = await stageOpenCatalogHead(authorPersistence);
    const receivedAnnouncements: Array<{
      announcement: Rfc64PublicCatalogHeadAnnouncementV1;
      remotePeerId: string;
    }> = [];
    const authorAuthorizations: Rfc64CatalogAccessAuthorizationInputV1[] = [];
    const receiverAuthorizations: Rfc64CatalogAccessAuthorizationInputV1[] = [];
    const replayRequests: Array<{
      request: Readonly<Rfc64PublicCatalogHeadReplayRequestV1>;
      remotePeerId: string;
    }> = [];
    const authorPolicy = policyRegistry(
      LOCAL_MEMBER,
      REMOTE_MEMBER,
      accessPolicy,
      publishPolicy,
    );
    const receiverPolicy = policyRegistry(
      REMOTE_MEMBER,
      LOCAL_MEMBER,
      accessPolicy,
      publishPolicy,
    );

    const authorTransport = new Rfc64PublicCatalogTransportV1(
      new ProtocolRouter(authorNode),
      {
        controlObjects: authorPersistence.controlObjects,
        authorizeCatalogOperation: async (input) => {
          authorAuthorizations.push(input);
          return authorPolicy.authorize(input);
        },
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
        onCatalogHeadAvailable: async () => {},
        onCatalogHeadReplayRequested: (request, remotePeerId) => {
          replayRequests.push({ request, remotePeerId });
          return Object.freeze({
            status: 'admitted' as const,
            completion: Promise.resolve(Object.freeze({
              announced: 1,
              failed: 0,
              manifest: Object.freeze([announcement]),
            })),
          });
        },
      },
    );
    const receiverTransport = new Rfc64PublicCatalogTransportV1(
      new ProtocolRouter(receiverNode),
      {
        controlObjects: receiverPersistence.controlObjects,
        authorizeCatalogOperation: async (input) => {
          receiverAuthorizations.push(input);
          return receiverPolicy.authorize(input);
        },
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
        onCatalogHeadAvailable: async (received, remotePeerId) => {
          receivedAnnouncements.push({ announcement: received, remotePeerId });
        },
      },
    );
    transports.push(authorTransport, receiverTransport);
    authorTransport.start();
    receiverTransport.start();

    expect(RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1)
      .toBe('/dkg/catalog/1/author-head-availability');
    expect(RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1)
      .toBe('/dkg/catalog/1/control-object/author-head');
    expect(RFC64_PUBLIC_CATALOG_HEAD_REPLAY_PROTOCOL_V1)
      .toBe('/dkg/catalog/1/author-head-replay');
    expect(RFC64_PUBLIC_CATALOG_HEAD_REPLAY_PROTOCOL_V2)
      .toBe('/dkg/catalog/2/author-head-replay');

    const replayRequest = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
      networkId: announcement.networkId,
      contextGraphId: announcement.contextGraphId,
      policyDigest: announcement.policyDigest,
    });
    await expect(receiverTransport.requestCatalogHeadReplay(authorNode.peerId, replayRequest))
      .resolves.toEqual({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
        heads: [announcement],
      });
    expect(replayRequests).toEqual([{
      request: replayRequest,
      remotePeerId: receiverNode.peerId,
    }]);

    await authorTransport.announceCatalogHead(receiverNode.peerId, announcement);
    expect(receivedAnnouncements).toEqual([{
      announcement,
      remotePeerId: authorNode.peerId,
    }]);

    const fetched = await receiverTransport.fetchCatalogHead(authorNode.peerId, announcement);
    expect(fetched?.envelope.objectDigest).toBe(announcement.catalogHeadObjectDigest);
    expect(fetched?.envelope.payload).toMatchObject({
      authorAddress: announcement.authorAddress,
      contextGraphId: announcement.contextGraphId,
      era: announcement.catalogEra,
      version: announcement.catalogVersion,
    });

    const receiverStage = await receiverPersistence.controlObjects.stageVerifiedObjects([fetched!]);
    expect(receiverStage.objects).toEqual([{
      objectDigest: announcement.catalogHeadObjectDigest,
      signatureVariantDigest: announcement.signatureVariantDigest,
    }]);
    const receiverRead = await receiverPersistence.controlObjects.getVerifiedObject({
      objectDigest: announcement.catalogHeadObjectDigest,
      signatureVariantDigest: announcement.signatureVariantDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    expect(receiverRead?.envelope).toEqual(fetched?.envelope);

    expect(authorAuthorizations.map((input) => input.operation)).toEqual([
      'head-replay-inbound',
      'head-replay-inbound',
      'announce-outbound',
      'announce-outbound',
      'fetch-inbound',
      'fetch-inbound',
    ]);
    expect(receiverAuthorizations.map((input) => input.operation)).toEqual([
      'head-replay-outbound',
      'head-replay-outbound',
      'announce-inbound',
      'announce-inbound',
      'fetch-outbound',
      'fetch-outbound',
      'fetch-outbound',
    ]);
    },
    30_000,
  );

  it('returns the replay manifest only after admitted replay completion settles', async () => {
    const handlers = new Map<
      string,
      Parameters<ProtocolRouter['register']>[1]
    >();
    const providerRouter = {
      register: (protocolId: string, handler: Parameters<ProtocolRouter['register']>[1]) => {
        handlers.set(protocolId, handler);
      },
      unregister: (protocolId: string) => { handlers.delete(protocolId); },
      send: vi.fn(),
    } as unknown as ProtocolRouter;
    const requesterSend = vi.fn(async (
      _peerId: string,
      protocolId: string,
      data: Uint8Array,
    ) => {
      const handler = handlers.get(protocolId);
      if (handler === undefined) throw new Error(`missing handler for ${protocolId}`);
      return handler(data, {
        toString: () => 'requester-peer',
        toBytes: () => new Uint8Array(),
      });
    });
    const requesterRouter = {
      register: () => {},
      unregister: () => {},
      send: requesterSend,
    } as unknown as ProtocolRouter;
    let releaseCompletion!: () => void;
    let completionSettled = false;
    const completion = new Promise<Readonly<{
      announced: number;
      failed: number;
      manifest: readonly Rfc64PublicCatalogHeadAnnouncementV1[];
    }>>((resolve) => {
      releaseCompletion = () => {
        completionSettled = true;
        resolve(Object.freeze({
          announced: 0,
          failed: 0,
          manifest: Object.freeze([]),
        }));
      };
    });
    const provider = new Rfc64PublicCatalogTransportV1(providerRouter, {
      controlObjects: { getVerifiedObject: async () => null },
      authorizeCatalogOperation: OPEN_POLICY,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      onCatalogHeadAvailable: async () => {},
      onCatalogHeadReplayRequested: () => Object.freeze({
        status: 'admitted' as const,
        completion,
      }),
    });
    const requester = new Rfc64PublicCatalogTransportV1(requesterRouter, {
      controlObjects: { getVerifiedObject: async () => null },
      authorizeCatalogOperation: OPEN_POLICY,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      onCatalogHeadAvailable: async () => {},
    });
    transports.push(provider, requester);
    provider.start();
    requester.start();

    let requestSettled = false;
    const replay = requester.requestCatalogHeadReplay('provider-peer', replayRequest());
    void replay.then(() => { requestSettled = true; });
    await vi.waitFor(() => { expect(requesterSend).toHaveBeenCalledOnce(); });
    expect(completionSettled).toBe(false);
    expect(requestSettled).toBe(false);
    releaseCompletion();
    await expect(replay).resolves.toEqual({
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
      heads: [],
    });
  });

  it('retries only overload and reports a typed error at the persistent bound', async () => {
    const send = vi.fn(async () => Uint8Array.of(2));
    const wait = vi.fn(async () => {});
    const requester = requesterTransportForReplay(send, {
      maxAttempts: 3,
      wait,
    });

    await expect(requester.requestCatalogHeadReplay('provider-peer', replayRequest()))
      .rejects.toMatchObject({ code: 'catalog-transport-overloaded' });
    expect(send).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([delayMs]) => delayMs)).toEqual([100, 200]);
  });

  it('retries overload until the provider admits the request', async () => {
    const completion = encodeRfc64PublicCatalogHeadReplayCompletionV2(Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
      heads: Object.freeze([]),
    }));
    const responses = [Uint8Array.of(2), Uint8Array.of(2), completion];
    const send = vi.fn(async () => responses.shift() ?? Uint8Array.of(2));
    const wait = vi.fn(async () => {});
    const requester = requesterTransportForReplay(send, {
      maxAttempts: 4,
      wait,
    });

    await expect(requester.requestCatalogHeadReplay('provider-peer', replayRequest()))
      .resolves.toEqual({
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
        heads: [],
      });
    expect(send).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([delayMs]) => delayMs)).toEqual([100, 200]);
  });

  it('reports an authorized provider with no replay admission callback as busy', async () => {
    const handlers = new Map<
      string,
      Parameters<ProtocolRouter['register']>[1]
    >();
    const provider = new Rfc64PublicCatalogTransportV1({
      register: (protocolId: string, handler: Parameters<ProtocolRouter['register']>[1]) => {
        handlers.set(protocolId, handler);
      },
      unregister: (protocolId: string) => { handlers.delete(protocolId); },
      send: vi.fn(),
    } as unknown as ProtocolRouter, {
      controlObjects: { getVerifiedObject: async () => null },
      authorizeCatalogOperation: OPEN_POLICY,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      onCatalogHeadAvailable: async () => {},
    });
    const send = vi.fn(async (
      _peerId: string,
      protocolId: string,
      data: Uint8Array,
    ) => {
      const handler = handlers.get(protocolId);
      if (handler === undefined) throw new Error(`missing handler for ${protocolId}`);
      return handler(data, {
        toString: () => 'requester-peer',
        toBytes: () => new Uint8Array(),
      });
    });
    const requester = requesterTransportForReplay(send, {
      maxAttempts: 1,
      wait: async () => {},
    });
    transports.push(provider);
    provider.start();

    await expect(requester.requestCatalogHeadReplay('provider-peer', replayRequest()))
      .rejects.toMatchObject({ code: 'catalog-transport-overloaded' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not retry policy denial', async () => {
    const send = vi.fn(async () => Uint8Array.of(0));
    const wait = vi.fn(async () => {});
    const requester = requesterTransportForReplay(send, {
      maxAttempts: 4,
      wait,
    });

    await expect(requester.requestCatalogHeadReplay('provider-peer', replayRequest()))
      .rejects.toMatchObject({ code: 'catalog-transport-policy-denied' });
    expect(send).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it('rechecks policy after an overload wait before retrying', async () => {
    let current = true;
    const send = vi.fn(async () => Uint8Array.of(2));
    const wait = vi.fn(async () => { current = false; });
    const requester = requesterTransportForReplay(send, {
      maxAttempts: 4,
      wait,
    }, async () => current ? Object.freeze({
      accessPolicy: 0 as const,
      policyDigest: POLICY_DIGEST,
    }) : null);

    await expect(requester.requestCatalogHeadReplay('provider-peer', replayRequest()))
      .rejects.toMatchObject({ code: 'catalog-transport-policy-denied' });
    expect(send).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });

  it('passes caller cancellation into the overload retry wait', async () => {
    const controller = new AbortController();
    const reason = new Error('stop replay retries');
    const send = vi.fn(async () => Uint8Array.of(2));
    let observedSignal: AbortSignal | undefined;
    const wait = vi.fn(async (_delayMs: number, signal?: AbortSignal) => {
      observedSignal = signal;
      controller.abort(reason);
      if (signal?.aborted) throw signal.reason;
    });
    const requester = requesterTransportForReplay(send, {
      maxAttempts: 4,
      wait,
    });

    await expect(requester.requestCatalogHeadReplay(
      'provider-peer',
      replayRequest(),
      { signal: controller.signal },
    )).rejects.toBe(reason);
    expect(send).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
    expect(wait.mock.calls[0]?.[0]).toBe(100);
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(reason);
  });

  it('aborts an overload retry when the transport stops', async () => {
    const send = vi.fn(async () => Uint8Array.of(2));
    let enteredWait!: () => void;
    const waitStarted = new Promise<void>((resolve) => { enteredWait = resolve; });
    const wait = vi.fn(async (_delayMs: number, signal?: AbortSignal) => {
      enteredWait();
      if (signal === undefined) throw new Error('retry wait received no lifecycle signal');
      if (signal.aborted) throw signal.reason;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const requester = requesterTransportForReplay(send, {
      maxAttempts: 4,
      wait,
    });

    const replay = requester.requestCatalogHeadReplay('provider-peer', replayRequest());
    await waitStarted;
    requester.stop();

    await expect(replay).rejects.toMatchObject({ code: 'catalog-transport-state' });
    expect(send).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });

  it('denies an unauthorized fetch before revealing cache hit or miss state', async () => {
    const [providerNode, requesterNode] = await Promise.all([startNode(), startNode()]);
    await connect(requesterNode, providerNode);
    const getVerifiedObject = vi.fn(async () => null);
    const replayRequested = vi.fn();
    const announcement = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
      networkId: 'otp:20430',
      contextGraphId: '0x1111111111111111111111111111111111111111/private',
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0',
      catalogVersion: '0',
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: `0x${'81'.repeat(32)}`,
      signatureVariantDigest: `0x${'82'.repeat(32)}`,
    }) as Rfc64PublicCatalogHeadAnnouncementV1;

    const providerTransport = new Rfc64PublicCatalogTransportV1(
      new ProtocolRouter(providerNode),
      {
        controlObjects: { getVerifiedObject },
        authorizeCatalogOperation: async () => null,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
        onCatalogHeadAvailable: async () => {},
        onCatalogHeadReplayRequested: replayRequested,
      },
    );
    const requesterTransport = new Rfc64PublicCatalogTransportV1(
      new ProtocolRouter(requesterNode),
      {
        controlObjects: { getVerifiedObject: vi.fn(async () => null) },
        authorizeCatalogOperation: OPEN_POLICY,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
        onCatalogHeadAvailable: async () => {},
      },
    );
    transports.push(providerTransport, requesterTransport);
    providerTransport.start();
    requesterTransport.start();

    await expect(requesterTransport.fetchCatalogHead(
      providerNode.peerId,
      announcement,
      { timeoutMs: 4_000 },
    )).rejects.toThrow();
    expect(getVerifiedObject).not.toHaveBeenCalled();
    await expect(requesterTransport.requestCatalogHeadReplay(
      providerNode.peerId,
      {
        kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
        networkId: announcement.networkId,
        contextGraphId: announcement.contextGraphId,
        policyDigest: announcement.policyDigest,
      },
      { timeoutMs: 4_000 },
    )).rejects.toMatchObject({ code: 'catalog-transport-policy-denied' });
    expect(replayRequested).not.toHaveBeenCalled();
  }, 15_000);

  it('keeps the deprecated open authorizer fail-closed for private policy', async () => {
    const [providerNode, requesterNode] = await Promise.all([startNode(), startNode()]);
    await connect(requesterNode, providerNode);
    const getVerifiedObject = vi.fn(async () => null);
    const announcement = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
      networkId: 'otp:20430',
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0',
      catalogVersion: '0',
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: `0x${'81'.repeat(32)}`,
      signatureVariantDigest: `0x${'82'.repeat(32)}`,
    }) as Rfc64PublicCatalogHeadAnnouncementV1;
    const providerTransport = new Rfc64PublicCatalogTransportV1(
      new ProtocolRouter(providerNode),
      {
        controlObjects: { getVerifiedObject },
        authorizeOpenCatalogOperation: async () => ({
          accessPolicy: 1,
          policyDigest: POLICY_DIGEST,
        }),
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
        onCatalogHeadAvailable: async () => {},
      },
    );
    const requesterTransport = new Rfc64PublicCatalogTransportV1(
      new ProtocolRouter(requesterNode),
      {
        controlObjects: { getVerifiedObject: async () => null },
        authorizeCatalogOperation: OPEN_POLICY,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
        onCatalogHeadAvailable: async () => {},
      },
    );
    transports.push(providerTransport, requesterTransport);
    providerTransport.start();
    requesterTransport.start();

    await expect(requesterTransport.fetchCatalogHead(
      providerNode.peerId,
      announcement,
      { timeoutMs: 4_000 },
    )).rejects.toMatchObject({ code: 'catalog-transport-policy-denied' });
    expect(getVerifiedObject).not.toHaveBeenCalled();
  }, 15_000);

  it('rechecks current authorization after the outbound fetch await', async () => {
    const send = vi.fn(async () => Uint8Array.of(0));
    const router = {
      register: () => {},
      unregister: () => {},
      send,
    } as unknown as ProtocolRouter;
    let authorizationChecks = 0;
    const transport = new Rfc64PublicCatalogTransportV1(router, {
      controlObjects: { getVerifiedObject: async () => null },
      authorizeCatalogOperation: async () => {
        authorizationChecks += 1;
        return authorizationChecks === 1 ? {
          accessPolicy: 1,
          policyDigest: POLICY_DIGEST,
        } : null;
      },
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      onCatalogHeadAvailable: async () => {},
    });
    transports.push(transport);
    transport.start();
    const announcement = {
      kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
      networkId: 'otp:20430',
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0',
      catalogVersion: '0',
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: `0x${'81'.repeat(32)}`,
      signatureVariantDigest: `0x${'82'.repeat(32)}`,
    } as Rfc64PublicCatalogHeadAnnouncementV1;

    await expect(transport.fetchCatalogHead('remote-peer', announcement))
      .rejects.toMatchObject({ code: 'catalog-transport-policy-denied' });
    expect(send).toHaveBeenCalledOnce();
    expect(authorizationChecks).toBe(2);
  });

  it('rejects a stale registry digest before sending any wire request', async () => {
    const send = vi.fn(async () => Uint8Array.of(0));
    const transport = new Rfc64PublicCatalogTransportV1({
      register: () => {},
      unregister: () => {},
      send,
    } as unknown as ProtocolRouter, {
      controlObjects: { getVerifiedObject: async () => null },
      authorizeCatalogOperation: async () => ({
        accessPolicy: 1,
        policyDigest: `0x${'99'.repeat(32)}` as Digest32V1,
      }),
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      onCatalogHeadAvailable: async () => {},
    });
    transports.push(transport);
    transport.start();
    const announcement = {
      kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
      networkId: 'otp:20430',
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0',
      catalogVersion: '0',
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: `0x${'81'.repeat(32)}`,
      signatureVariantDigest: `0x${'82'.repeat(32)}`,
    } as Rfc64PublicCatalogHeadAnnouncementV1;

    await expect(transport.fetchCatalogHead('remote-peer', announcement))
      .rejects.toMatchObject({ code: 'catalog-transport-policy-denied' });
    expect(send).not.toHaveBeenCalled();
  });

  it('round-trips only exact canonical announcement fields', () => {
    const announcement = Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
      networkId: 'otp:20430',
      contextGraphId: '0x1111111111111111111111111111111111111111/codec',
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0',
      catalogVersion: '1',
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: `0x${'91'.repeat(32)}`,
      signatureVariantDigest: `0x${'92'.repeat(32)}`,
    }) as Rfc64PublicCatalogHeadAnnouncementV1;
    const encoded = encodeRfc64PublicCatalogHeadAnnouncementV1(announcement);
    expect(parseRfc64PublicCatalogHeadAnnouncementV1(encoded)).toEqual(announcement);

    const parsed = JSON.parse(new TextDecoder().decode(encoded));
    const noncanonical = new TextEncoder().encode(JSON.stringify(
      Object.fromEntries(Object.entries(parsed).reverse()),
    ));
    expect(() => parseRfc64PublicCatalogHeadAnnouncementV1(noncanonical))
      .toThrow(/canonical JCS/);

    const withUnknown = new TextEncoder().encode(JSON.stringify({ ...parsed, surprise: 'x' }));
    expect(() => parseRfc64PublicCatalogHeadAnnouncementV1(withUnknown))
      .toThrow(/missing or unknown fields/);
  });
});
