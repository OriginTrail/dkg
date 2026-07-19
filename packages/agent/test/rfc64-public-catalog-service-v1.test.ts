import {
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1,
  computeControlSignatureVariantDigestHex,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type EvmAddressV1,
  type ProtocolRouter,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import type { Rfc64ControlObjectOperationsV1 } from '../src/rfc64/control-object-store-v1.js';
import {
  Rfc64PublicCatalogServiceV1,
  type Rfc64PublicCatalogReconcilerClientsV1,
} from '../src/rfc64/public-catalog-service-v1.js';
import {
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
} from '../src/rfc64/public-catalog-native-transport-v1.js';
import type { Rfc64PublicCatalogReceiverReconcilerV1 } from '../src/rfc64/public-catalog-receiver-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
  RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1,
  encodeRfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';

const NETWORK_ID = 'otp:20430' as const;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/service-lifecycle' as const;
const GOVERNANCE_CONTRACT =
  '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const OTHER_WALLET = new ethers.Wallet(`0x${'65'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const HEAD_ISSUED_AT = '1773900000000' as TimestampMsV1;
const DELEGATION_EFFECTIVE_AT = '1773899999000' as TimestampMsV1;
const DELEGATION_EXPIRES_AT = '1774000000000' as TimestampMsV1;
const DELEGATION_DIGEST = `0x${'72'.repeat(32)}` as Digest32V1;

type RouterHandler = (
  data: Uint8Array,
  peerId: { toString(): string },
) => Promise<Uint8Array>;

class RecordingRouter {
  readonly handlers = new Map<string, RouterHandler>();
  readonly events: string[] = [];
  failRegistrationFor: string | undefined;
  sendResponse: (protocolId: string) => Promise<Uint8Array> = async () => Uint8Array.of(0);

  register(protocolId: string, handler: RouterHandler): void {
    this.events.push(`register:${protocolId}`);
    if (protocolId === this.failRegistrationFor) {
      throw new Error(`registration failed for ${protocolId}`);
    }
    this.handlers.set(protocolId, handler);
  }

  unregister(protocolId: string): void {
    this.events.push(`unregister:${protocolId}`);
    this.handlers.delete(protocolId);
  }

  async send(
    _peerId: string,
    protocolId: string,
    _data: Uint8Array,
  ): Promise<Uint8Array> {
    this.events.push(`send:${protocolId}`);
    return this.sendResponse(protocolId);
  }

  asProtocolRouter(): ProtocolRouter {
    return this as unknown as ProtocolRouter;
  }

  async invoke(
    protocolId: string,
    data: Uint8Array,
    remotePeerId = 'peer-a',
  ): Promise<Uint8Array> {
    const handler = this.handlers.get(protocolId);
    if (handler === undefined) throw new Error(`protocol is not registered: ${protocolId}`);
    return handler(data, { toString: () => remotePeerId });
  }
}

function controlObjects(): Rfc64ControlObjectOperationsV1 {
  return {
    namespaceDurability: 'posix-hardlink-no-replace-directory-fsync-v1',
    getVerifiedObject: vi.fn(async () => null),
    stageVerifiedObjects: vi.fn(async (input) => ({
      durable: true,
      namespaceDurability: 'posix-hardlink-no-replace-directory-fsync-v1',
      objects: input.map(({ envelope }) => ({
        objectDigest: envelope.objectDigest,
        signatureVariantDigest: computeControlSignatureVariantDigestHex(
          envelope.objectDigest,
          envelope.signature,
        ),
      })),
    })),
  };
}

function exactStageReceipt(
  input: readonly { readonly envelope: { readonly objectDigest: string; readonly signature: string } }[],
) {
  return Object.freeze({
    durable: true as const,
    namespaceDurability: 'posix-hardlink-no-replace-directory-fsync-v1' as const,
    objects: Object.freeze(input.map(({ envelope }) => Object.freeze({
      objectDigest: envelope.objectDigest as Digest32V1,
      signatureVariantDigest: computeControlSignatureVariantDigestHex(
        envelope.objectDigest,
        envelope.signature,
      ),
    }))),
  });
}

function inertReconciler(): Rfc64PublicCatalogReceiverReconcilerV1 {
  return {
    isHeadApplied: async () => false,
    reconcileHead: async () => 'not-found',
  };
}

function nativeOptions(
  createReconciler: (
    clients: Readonly<Rfc64PublicCatalogReconcilerClientsV1>,
  ) => Rfc64PublicCatalogReceiverReconcilerV1,
) {
  return {
    readCatalogObjectByDigest: async () => null,
    readKaBundleByDigest: async () => null,
    createReconciler,
  } as const;
}

function acceptPolicy(service: Rfc64PublicCatalogServiceV1) {
  return service.acceptOpenPolicy({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR,
  });
}

function genesisInput(
  service: Rfc64PublicCatalogServiceV1,
  overrides: Record<string, unknown> = {},
) {
  return {
    scope: {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    } as AuthorCatalogScopeV1,
    signer: {
      issuer: AUTHOR,
      signDigest: (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest),
    },
    issuedAt: HEAD_ISSUED_AT,
    catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
    catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    policy: acceptPolicy(service),
    peers: ['peer-a'],
    ...overrides,
  };
}

function announcement(policyDigest: Digest32V1): Rfc64PublicCatalogHeadAnnouncementV1 {
  return {
    kind: 'rfc64-author-catalog-head-availability-v1',
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    subGraphName: null,
    authorAddress: AUTHOR,
    catalogEra: '0',
    catalogVersion: '0',
    policyDigest,
    catalogHeadObjectDigest: `0x${'aa'.repeat(32)}`,
    signatureVariantDigest: `0x${'bb'.repeat(32)}`,
  } as Rfc64PublicCatalogHeadAnnouncementV1;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function countEvent(router: RecordingRouter, event: string): number {
  return router.events.filter((candidate) => candidate === event).length;
}

describe('RFC-64 public catalog service v1 lifecycle ownership', () => {
  it('durably stages the exact signed delegation before genesis and only then announces', async () => {
    const router = new RecordingRouter();
    const store = controlObjects();
    vi.mocked(store.stageVerifiedObjects).mockImplementation(async (input) => {
      router.events.push(`stage:${input.map(({ envelope }) => envelope.objectType).join(',')}`);
      return exactStageReceipt(input);
    });
    router.sendResponse = async () => Uint8Array.of(1);
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: store,
    });
    service.start();

    const result = await service.publishOpenAuthorCatalogGenesis(genesisInput(service));
    const stageCalls = vi.mocked(store.stageVerifiedObjects).mock.calls;
    expect(stageCalls).toHaveLength(2);
    expect(stageCalls[0][0].map(({ envelope }) => envelope.objectType)).toEqual([
      AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
    ]);
    expect(stageCalls[1][0].map(({ envelope }) => envelope.objectType)).toEqual([
      AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    ]);
    const delegation = result.catalogIssuerAuthorization.catalogIssuerDelegation;
    expect(result.catalogIssuerDelegationObjectDigest).toBe(delegation.objectDigest);
    expect(result.catalogIssuerDelegationSignatureVariantDigest).toBe(
      computeControlSignatureVariantDigestHex(delegation.objectDigest, delegation.signature),
    );
    const head = stageCalls[1][0].at(-1)?.envelope;
    expect(head?.payload).toMatchObject({
      catalogIssuerDelegationDigest: delegation.objectDigest,
      issuedAt: HEAD_ISSUED_AT,
    });
    expect(result.catalogIssuerAuthorization.parentAuthorAgentEvidence).toBeNull();
    expect(router.events.filter((event) => event.startsWith('stage:') || event.startsWith('send:')))
      .toEqual([
        `stage:${AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1}`,
        `stage:${AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1},${AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1}`,
        `send:${RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1}`,
      ]);
    expect(result.announcedPeers).toEqual(['peer-a']);
    await service.close();
  });

  it('rejects signer and accepted-policy scope mismatches before staging or announcing', async () => {
    const router = new RecordingRouter();
    const store = controlObjects();
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: store,
    });
    service.start();

    await expect(service.publishOpenAuthorCatalogGenesis(genesisInput(service, {
      signer: {
        issuer: OTHER_WALLET.address.toLowerCase(),
        signDigest: (digest: Uint8Array) => OTHER_WALLET.signMessage(digest),
      },
    }) as never)).rejects.toThrow(/signer must equal the exact catalog author/);

    const wrongPolicy = service.acceptOpenPolicy({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: OTHER_WALLET.address.toLowerCase() as EvmAddressV1,
    });
    await expect(service.publishOpenAuthorCatalogGenesis(genesisInput(service, {
      policy: wrongPolicy,
    }) as never)).rejects.toThrow(/not bound to the exact catalog/);
    expect(store.stageVerifiedObjects).not.toHaveBeenCalled();
    expect(router.events.some((event) => event.startsWith('send:'))).toBe(false);
    await service.close();
  });

  it('rejects an expired delegation before signing, staging, or announcing', async () => {
    const router = new RecordingRouter();
    const store = controlObjects();
    const signDigest = vi.fn((digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest));
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: store,
    });
    service.start();

    await expect(service.publishOpenAuthorCatalogGenesis(genesisInput(service, {
      signer: { issuer: AUTHOR, signDigest },
      catalogIssuerDelegationExpiresAt: HEAD_ISSUED_AT,
    }) as never)).rejects.toThrow(/half-open interval/);
    expect(signDigest).not.toHaveBeenCalled();
    expect(store.stageVerifiedObjects).not.toHaveBeenCalled();
    expect(router.events.some((event) => event.startsWith('send:'))).toBe(false);
    await service.close();
  });

  it('does not construct or announce a head when delegation staging is not durable', async () => {
    const router = new RecordingRouter();
    const store = controlObjects();
    vi.mocked(store.stageVerifiedObjects).mockRejectedValueOnce(
      new Error('delegation durability barrier failed'),
    );
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: store,
    });
    service.start();

    await expect(service.publishOpenAuthorCatalogGenesis(genesisInput(service)))
      .rejects.toThrow('delegation durability barrier failed');
    expect(store.stageVerifiedObjects).toHaveBeenCalledTimes(1);
    expect(router.events.some((event) => event.startsWith('send:'))).toBe(false);
    await service.close();
  });

  it('does not announce when genesis staging fails after durable delegation staging', async () => {
    const router = new RecordingRouter();
    const store = controlObjects();
    vi.mocked(store.stageVerifiedObjects)
      .mockImplementationOnce(async (input) => exactStageReceipt(input))
      .mockRejectedValueOnce(new Error('genesis durability barrier failed'));
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: store,
    });
    service.start();

    await expect(service.publishOpenAuthorCatalogGenesis(genesisInput(service)))
      .rejects.toThrow('genesis durability barrier failed');
    expect(store.stageVerifiedObjects).toHaveBeenCalledTimes(2);
    expect(router.events.some((event) => event.startsWith('send:'))).toBe(false);
    await service.close();
  });

  it('constructs one reconciler with frozen fetch-only capabilities and the configured timeout', async () => {
    const router = new RecordingRouter();
    let clients: Readonly<Rfc64PublicCatalogReconcilerClientsV1> | undefined;
    const createReconciler = vi.fn((input: Readonly<Rfc64PublicCatalogReconcilerClientsV1>) => {
      clients = input;
      return inertReconciler();
    });
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      transportTimeoutMs: 4_321,
      native: nativeOptions(createReconciler),
    });

    expect(createReconciler).toHaveBeenCalledTimes(1);
    expect(clients).toBeDefined();
    expect(Object.keys(clients!)).toEqual([
      'headTransport',
      'contentTransport',
      'transportTimeoutMs',
    ]);
    expect(clients!.transportTimeoutMs).toBe(4_321);
    expect(Object.keys(clients!.headTransport)).toEqual(['fetchCatalogHead']);
    expect(Object.keys(clients!.contentTransport)).toEqual([
      'fetchCatalogObject',
      'fetchKaBundle',
    ]);
    expect('start' in clients!.headTransport).toBe(false);
    expect('stop' in clients!.headTransport).toBe(false);
    expect('router' in clients!.headTransport).toBe(false);
    expect('start' in clients!.contentTransport).toBe(false);
    expect('stop' in clients!.contentTransport).toBe(false);
    expect('router' in clients!.contentTransport).toBe(false);
    expect(Object.isFrozen(clients)).toBe(true);
    expect(Object.isFrozen(clients!.headTransport)).toBe(true);
    expect(Object.isFrozen(clients!.contentTransport)).toBe(true);

    service.start();
    service.start();
    expect(createReconciler).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it('starts native content protocols before exposing head announcements', async () => {
    const router = new RecordingRouter();
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      native: nativeOptions(() => inertReconciler()),
    });

    service.start();
    expect(router.events.filter((event) => event.startsWith('register:'))).toEqual([
      `register:${RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1}`,
      `register:${RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1}`,
      `register:${RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1}`,
      `register:${RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1}`,
    ]);
    await service.close();
  });

  it('rolls native content protocols back when head transport startup fails', async () => {
    const router = new RecordingRouter();
    router.failRegistrationFor = RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1;
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      native: nativeOptions(() => inertReconciler()),
    });

    expect(() => service.start()).toThrow('registration failed');
    expect(service.started).toBe(false);
    expect(router.handlers.size).toBe(0);
    expect(countEvent(
      router,
      `unregister:${RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1}`,
    )).toBe(1);
    expect(countEvent(
      router,
      `unregister:${RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1}`,
    )).toBe(1);
    await service.close();
  });

  it('rejects new schedules while close drains, keeps fetch clients live, then stops once', async () => {
    const router = new RecordingRouter();
    const reconcileStarted = deferred<void>();
    const reconcileResult = deferred<'applied'>();
    let clients: Readonly<Rfc64PublicCatalogReconcilerClientsV1> | undefined;
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      receiver: { retryBackoffMs: 0 },
      native: nativeOptions((input) => {
        clients = input;
        return {
          isHeadApplied: async () => false,
          reconcileHead: async () => {
            reconcileStarted.resolve();
            return reconcileResult.promise;
          },
        };
      }),
    });
    const policy = acceptPolicy(service);
    const head = announcement(policy.policyDigest);
    const wireHead = encodeRfc64PublicCatalogHeadAnnouncementV1(head);

    service.start();
    await expect(router.invoke(
      RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
      wireHead,
    )).resolves.toEqual(Uint8Array.of(1));
    await reconcileStarted.promise;
    expect(service.stats().receiver.scheduled).toBe(1);

    const closePromise = service.close();
    expect(service.started).toBe(false);
    expect(router.handlers.has(RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1)).toBe(true);
    expect(router.handlers.has(RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1)).toBe(true);
    expect(router.handlers.has(RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1)).toBe(true);
    expect(router.handlers.has(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1)).toBe(true);

    await expect(clients!.headTransport.fetchCatalogHead('peer-b', head)).resolves.toBeNull();
    await expect(clients!.contentTransport.fetchKaBundle('peer-b', {
      kind: RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
      networkId: head.networkId,
      contextGraphId: head.contextGraphId,
      subGraphName: head.subGraphName,
      authorAddress: head.authorAddress,
      catalogEra: head.catalogEra,
      catalogVersion: head.catalogVersion,
      policyDigest: head.policyDigest,
      catalogHeadObjectDigest: head.catalogHeadObjectDigest,
      blobDigest: `0x${'cc'.repeat(32)}` as Digest32V1,
      byteLength: '0',
    })).resolves.toBeNull();

    await expect(router.invoke(
      RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
      wireHead,
      'peer-c',
    )).resolves.toEqual(Uint8Array.of(1));
    expect(service.stats().receiver.scheduled).toBe(1);

    reconcileResult.resolve('applied');
    await closePromise;
    await service.close();
    expect(router.handlers.size).toBe(0);
    for (const protocolId of [
      RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
      RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1,
      RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
      RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1,
    ]) {
      expect(countEvent(router, `unregister:${protocolId}`)).toBe(1);
    }
  });

  it('keeps diagnostic staging-only mode explicitly non-applied across replays', async () => {
    const router = new RecordingRouter();
    const store = controlObjects();
    const onHeadStaged = vi.fn();
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: store,
      onHeadStaged,
    });
    const policy = acceptPolicy(service);
    const produced = await produceEmptyAuthorCatalogGenesisV1({
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        governanceChainId: '20430',
        governanceContractAddress: GOVERNANCE_CONTRACT,
        ownershipTransitionDigest: null,
        subGraphName: null,
        authorAddress: AUTHOR,
        era: '0',
        bucketCount: '1',
      } as AuthorCatalogScopeV1,
      catalogIssuerDelegationDigest: DELEGATION_DIGEST,
      issuedAt: '1773900000000' as TimestampMsV1,
      signer: {
        issuer: AUTHOR,
        signDigest: (digest) => AUTHOR_WALLET.signMessage(digest),
      },
    });
    const head: Rfc64PublicCatalogHeadAnnouncementV1 = {
      kind: 'rfc64-author-catalog-head-availability-v1',
      networkId: produced.head.payload.networkId,
      contextGraphId: produced.head.payload.contextGraphId,
      subGraphName: produced.head.payload.subGraphName,
      authorAddress: produced.head.payload.authorAddress,
      catalogEra: produced.head.payload.era,
      catalogVersion: produced.head.payload.version,
      policyDigest: policy.policyDigest,
      catalogHeadObjectDigest: produced.head.objectDigest as Digest32V1,
      signatureVariantDigest: computeControlSignatureVariantDigestHex(
        produced.head.objectDigest,
        produced.head.signature,
      ),
    };
    const headBytes = canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(produced.head);
    const foundResponse = new Uint8Array(headBytes.byteLength + 1);
    foundResponse[0] = 1;
    foundResponse.set(headBytes, 1);
    router.sendResponse = async (protocolId) => protocolId === RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1
      ? foundResponse
      : Uint8Array.of(0);

    service.start();
    const wireHead = encodeRfc64PublicCatalogHeadAnnouncementV1(head);
    await router.invoke(RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1, wireHead);
    await service.whenReceiverIdle();
    await router.invoke(RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1, wireHead);
    await service.whenReceiverIdle();

    expect(store.stageVerifiedObjects).toHaveBeenCalledTimes(2);
    expect(onHeadStaged).toHaveBeenCalledTimes(2);
    expect(service.stats().receiver).toMatchObject({
      stagedOnly: 2,
      applied: 0,
      dedupedAlreadyApplied: 0,
    });
    await service.close();
  });
});
