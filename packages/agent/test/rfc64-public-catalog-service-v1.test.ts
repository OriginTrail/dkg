import {
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1,
  computeControlSignatureVariantDigestHex,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type ContextGraphPolicyV1,
  type EvmAddressV1,
  type MemberRosterV1,
  type ProtocolRouter,
  type SendOptions,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import {
  buildOpenOwnerContextGraphPolicyV1,
  computeOpenContextGraphPolicyDigestV1,
} from '../src/rfc64/open-catalog-policy-v1.js';
import type { Rfc64ControlObjectOperationsV1 } from '../src/rfc64/control-object-store-v1.js';
import {
  RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1,
  Rfc64PublicCatalogServiceV1,
  type Rfc64PublicCatalogReconcilerClientsV1,
} from '../src/rfc64/public-catalog-service-v1.js';
import {
  RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
  RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
  encodeRfc64PublicCatalogCurrentHeadQueryV1,
  parseRfc64PublicCatalogCurrentHeadQueryV1,
} from '../src/rfc64/public-catalog-current-head-discovery-v1.js';
import { Rfc64PublicCatalogNativeReceiverErrorV1 } from '../src/rfc64/public-catalog-native-receiver-v1.js';
import { mintRfc64CatalogNativeScopedReadCapabilityV1 } from
  '../src/rfc64/catalog-native-scoped-read-capability-v1-internal.js';
import { Rfc64CatalogMutationCoordinatorV1 } from
  '../src/rfc64/catalog-mutation-runtime-v1.js';
import {
  RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2,
  RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2,
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
  encodeRfc64PublicCatalogObjectFetchRequestV1,
} from '../src/rfc64/public-catalog-native-transport-v1.js';
import type { Rfc64PublicCatalogReceiverReconcilerV1 } from '../src/rfc64/public-catalog-receiver-v1.js';
import {
  Rfc64CatalogProviderFailureAggregateV1,
  classifyRfc64CatalogReconciliationTerminalReasonV1,
} from '../src/rfc64/public-catalog-reconciliation-failure-v1.js';
import { Rfc64CatalogReconciliationTerminalErrorV1 } from '../src/index.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
  RFC64_PUBLIC_CATALOG_HEAD_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1,
  encodeRfc64PublicCatalogHeadAnnouncementV1,
  encodeRfc64PublicCatalogHeadFetchRequestV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';

const NETWORK_ID = 'otp:20430' as const;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/service-lifecycle' as const;
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
  readonly sends: Array<Readonly<{
    peerId: string;
    protocolId: string;
    data: Uint8Array;
    options?: SendOptions;
  }>> = [];
  failRegistrationFor: string | undefined;
  sendResponse: (
    protocolId: string,
    options: SendOptions | undefined,
    peerId: string,
  ) => Promise<Uint8Array> = async () => Uint8Array.of(0);

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
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    options?: SendOptions,
  ): Promise<Uint8Array> {
    this.events.push(`send:${protocolId}`);
    this.sends.push(Object.freeze({ peerId, protocolId, data, options }));
    return this.sendResponse(protocolId, options, peerId);
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

function controlObjects() {
  return {
    namespaceDurability: 'posix-hardlink-no-replace-directory-fsync-v1',
    getVerifiedObject: vi.fn(async () => null),
    getVerifiedObjectByDigest: vi.fn(async () => null),
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

function accessPolicyAuthority() {
  return {
    localAgentAddress: AUTHOR,
    resolveRemoteAgentAddress: async () => null,
  } as const;
}

function catalogPolicy(
  contextGraphId: string,
  accessPolicy: 0 | 1,
  publishPolicy: 0 | 1,
): ContextGraphPolicyV1 {
  return {
    networkId: NETWORK_ID,
    contextGraphId: contextGraphId as ContextGraphPolicyV1['contextGraphId'],
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy,
    publishPolicy,
    publishAuthority: publishPolicy === 0
      ? OTHER_WALLET.address.toLowerCase() as EvmAddressV1
      : null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: { kind: 'owner-signed-unregistered', ownerAddress: AUTHOR, ownerAuthorityEra: '0' },
    effectiveAt: '0',
    issuedAt: '0',
  };
}

function memberRoster(
  policy: ContextGraphPolicyV1,
  policyDigest: Digest32V1,
): MemberRosterV1 {
  const members = [AUTHOR, OTHER_WALLET.address.toLowerCase() as EvmAddressV1]
    .sort()
    .map((agentAddress) => ({ agentAddress, roles: ['holder', 'provider'] as const }));
  return {
    networkId: policy.networkId,
    contextGraphId: policy.contextGraphId,
    ownershipTransitionDigest: policy.ownershipTransitionDigest,
    era: policy.era,
    version: '0',
    previousRosterDigest: null,
    policyDigest,
    administrativeDelegationDigest: policy.administrativeDelegationDigest,
    members,
    issuedAt: '0',
  };
}

/**
 * `memberRoster` enrols every wallet these tests author with, which makes the private branch of
 * `isSwmAuthorAuthorized` unfalsifiable. This builds the same roster minus one address so the
 * off-roster author case can actually be asserted.
 */
function rosterExcluding(
  policy: ContextGraphPolicyV1,
  policyDigest: Digest32V1,
  excluded: EvmAddressV1,
): MemberRosterV1 {
  const base = memberRoster(policy, policyDigest);
  return {
    ...base,
    members: base.members.filter((member) => member.agentAddress !== excluded),
  };
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
  it('keeps legacy-mode CG authoring out of the catalog authority', async () => {
    const router = new RecordingRouter();
    const store = controlObjects();
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: store,
      accessPolicyAuthority: accessPolicyAuthority(),
      resolveContextGraphAuthority: (contextGraphId) => Object.freeze({
        contextGraphId,
        selected: true,
        eligible: true,
        active: true,
        mode: 'legacy',
        killSwitchActive: false,
        legacySyncAllowed: true,
        track2Enabled: false,
        authoringAllowed: false,
        reconciliationLane: 'legacy',
      }),
    });
    service.start();

    await expect(service.publishOpenAuthorCatalogGenesis(genesisInput(service)))
      .rejects.toThrow(/authoring is disabled for legacy-mode CG/u);
    expect(store.stageVerifiedObjects).not.toHaveBeenCalled();
    expect(router.events.some((event) => event.startsWith('send:'))).toBe(false);
    await service.close();
  });

  it('keeps serving and authoring live while an edge receiver is inactive', async () => {
    const router = new RecordingRouter();
    const store = controlObjects();
    const readCatalogObjectByDigest = vi.fn(async () => null);
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async () => null);
    const inactiveReceiver = (contextGraphId: ContextGraphPolicyV1['contextGraphId']) =>
      Object.freeze({
        contextGraphId,
        selected: true,
        eligible: true,
        active: false,
        mode: 'catalog' as const,
        killSwitchActive: false,
        legacySyncAllowed: false,
        track2Enabled: false,
        authoringAllowed: false,
        reconciliationLane: 'disabled' as const,
      });
    const configuredServing = (contextGraphId: ContextGraphPolicyV1['contextGraphId']) =>
      Object.freeze({
        contextGraphId,
        selected: true,
        eligible: true,
        active: true,
        mode: 'catalog' as const,
        killSwitchActive: false,
        legacySyncAllowed: false,
        track2Enabled: true,
        authoringAllowed: true,
        reconciliationLane: 'catalog-apply' as const,
      });
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: store,
      native: {
        ...nativeOptions(() => inertReconciler()),
        readCatalogObjectByDigest,
        resolveScopedReadCapability: async (scope) =>
          mintRfc64CatalogNativeScopedReadCapabilityV1({
            scope,
            readCatalogObjectByDigest,
            readKaBundleByDigest: async () => null,
          }),
      },
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest },
      resolveContextGraphAuthority: (contextGraphId, direction) =>
        direction === 'serving'
          ? configuredServing(contextGraphId)
          : inactiveReceiver(contextGraphId),
    });
    const policy = acceptPolicy(service);
    service.start();

    const headRequest = {
      kind: RFC64_PUBLIC_CATALOG_HEAD_FETCH_KIND_V1,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0',
      catalogVersion: '0',
      policyDigest: policy.policyDigest,
      catalogHeadObjectDigest: `0x${'aa'.repeat(32)}` as Digest32V1,
      signatureVariantDigest: `0x${'bb'.repeat(32)}` as Digest32V1,
    } as const;
    await router.invoke(
      RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1,
      encodeRfc64PublicCatalogHeadFetchRequestV1(headRequest),
    );
    expect(store.getVerifiedObject).toHaveBeenCalledTimes(1);

    await router.invoke(
      RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
      encodeRfc64PublicCatalogObjectFetchRequestV1({
        kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: AUTHOR,
        catalogEra: '0',
        catalogVersion: '0',
        policyDigest: policy.policyDigest,
        catalogHeadObjectDigest: headRequest.catalogHeadObjectDigest,
        targetObjectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
        targetObjectDigest: `0x${'cc'.repeat(32)}` as Digest32V1,
      }),
    );
    expect(readCatalogObjectByDigest).toHaveBeenCalledTimes(1);

    await router.invoke(
      RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
      encodeRfc64PublicCatalogCurrentHeadQueryV1({
        kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: AUTHOR,
        catalogEra: '0',
        policyDigest: policy.policyDigest,
      }),
    );
    // The responder re-reads the applied head after loading the object so a
    // concurrent local head change cannot produce a stale discovery answer.
    expect(readCurrentAppliedCatalogHeadDigest).toHaveBeenCalledTimes(2);

    await expect(service.discoverCurrentCatalogHead({
      remotePeerId: 'peer-provider',
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: AUTHOR,
        catalogEra: '0',
      },
    })).rejects.toThrow(/not access-policy authorized/u);
    expect(countEvent(
      router,
      `send:${RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1}`,
    )).toBe(0);

    await expect(service.publishOpenAuthorCatalogGenesis(genesisInput(service, { peers: [] })))
      .resolves.toMatchObject({ announcedPeers: [], failedPeers: [] });
    expect(store.stageVerifiedObjects).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it('isolates legacy inbound protocols while serving a catalog-mode CG', async () => {
    const legacyCg = `${CONTEXT_GRAPH_ID}-legacy` as ContextGraphPolicyV1['contextGraphId'];
    const catalogCg = `${CONTEXT_GRAPH_ID}-catalog` as ContextGraphPolicyV1['contextGraphId'];
    const router = new RecordingRouter();
    const store = controlObjects();
    const readCatalogObjectByDigest = vi.fn(async () => null);
    const readCurrentAppliedCatalogHeadDigest = vi.fn(async () => null);
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: store,
      native: {
        ...nativeOptions(() => inertReconciler()),
        readCatalogObjectByDigest,
        resolveScopedReadCapability: async (scope) =>
          mintRfc64CatalogNativeScopedReadCapabilityV1({
            scope,
            readCatalogObjectByDigest,
            readKaBundleByDigest: async () => null,
          }),
      },
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest },
      resolveContextGraphAuthority: (contextGraphId) => Object.freeze(
        contextGraphId === legacyCg
          ? {
            contextGraphId,
            selected: true,
            eligible: true,
            active: true,
            mode: 'legacy' as const,
            killSwitchActive: false,
            legacySyncAllowed: true as const,
            track2Enabled: false,
            authoringAllowed: false,
            reconciliationLane: 'legacy' as const,
          }
          : {
            contextGraphId,
            selected: true,
            eligible: true,
            active: true,
            mode: 'catalog' as const,
            killSwitchActive: false,
            legacySyncAllowed: false as const,
            track2Enabled: true,
            authoringAllowed: true,
            reconciliationLane: 'catalog-apply' as const,
          },
      ),
    });
    const legacyPolicy = service.acceptOpenPolicy({
      networkId: NETWORK_ID,
      contextGraphId: legacyCg,
      ownerAddress: AUTHOR,
    });
    const catalogPolicySnapshot = service.acceptOpenPolicy({
      networkId: NETWORK_ID,
      contextGraphId: catalogCg,
      ownerAddress: AUTHOR,
    });
    service.start();

    const headRequest = (contextGraphId: typeof legacyCg, policyDigest: Digest32V1) => ({
      kind: RFC64_PUBLIC_CATALOG_HEAD_FETCH_KIND_V1,
      networkId: NETWORK_ID,
      contextGraphId,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0',
      catalogVersion: '0',
      policyDigest,
      catalogHeadObjectDigest: `0x${'aa'.repeat(32)}` as Digest32V1,
      signatureVariantDigest: `0x${'bb'.repeat(32)}` as Digest32V1,
    });
    const objectRequest = (contextGraphId: typeof legacyCg, policyDigest: Digest32V1) => ({
      kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
      networkId: NETWORK_ID,
      contextGraphId,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0',
      catalogVersion: '0',
      policyDigest,
      catalogHeadObjectDigest: `0x${'aa'.repeat(32)}` as Digest32V1,
      targetObjectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
      targetObjectDigest: `0x${'cc'.repeat(32)}` as Digest32V1,
    });
    const currentHeadQuery = (contextGraphId: typeof legacyCg, policyDigest: Digest32V1) => ({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      networkId: NETWORK_ID,
      contextGraphId,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0',
      policyDigest,
    });

    await router.invoke(
      RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1,
      encodeRfc64PublicCatalogHeadFetchRequestV1(headRequest(legacyCg, legacyPolicy.policyDigest)),
    );
    await router.invoke(
      RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
      encodeRfc64PublicCatalogObjectFetchRequestV1(
        objectRequest(legacyCg, legacyPolicy.policyDigest),
      ),
    );
    await router.invoke(
      RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
      encodeRfc64PublicCatalogCurrentHeadQueryV1(
        currentHeadQuery(legacyCg, legacyPolicy.policyDigest),
      ),
    );
    expect(store.getVerifiedObject).not.toHaveBeenCalled();
    expect(readCatalogObjectByDigest).not.toHaveBeenCalled();
    expect(readCurrentAppliedCatalogHeadDigest).not.toHaveBeenCalled();

    await router.invoke(
      RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1,
      encodeRfc64PublicCatalogHeadFetchRequestV1(
        headRequest(catalogCg, catalogPolicySnapshot.policyDigest),
      ),
    );
    await router.invoke(
      RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
      encodeRfc64PublicCatalogObjectFetchRequestV1(
        objectRequest(catalogCg, catalogPolicySnapshot.policyDigest),
      ),
    );
    await router.invoke(
      RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
      encodeRfc64PublicCatalogCurrentHeadQueryV1(
        currentHeadQuery(catalogCg, catalogPolicySnapshot.policyDigest),
      ),
    );
    expect(store.getVerifiedObject).toHaveBeenCalledTimes(1);
    expect(readCatalogObjectByDigest).toHaveBeenCalledTimes(1);
    expect(readCurrentAppliedCatalogHeadDigest).toHaveBeenCalled();
    await service.close();
  });

  it('preserves direct open-only construction and rejects private snapshots', async () => {
    const service = new Rfc64PublicCatalogServiceV1({
      router: new RecordingRouter().asProtocolRouter(),
      controlObjects: controlObjects(),
    });
    service.start();
    const accepted = service.acceptOpenPolicy({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    expect(accepted.policy.accessPolicy).toBe(0);

    const privatePolicy = catalogPolicy(`${CONTEXT_GRAPH_ID}-private`, 1, 1);
    const privateDigest = `0x${'31'.repeat(32)}` as Digest32V1;
    expect(() => service.acceptPolicySnapshot({
      policy: privatePolicy,
      policyDigest: privateDigest,
      roster: memberRoster(privatePolicy, privateDigest),
    })).toThrow(/requires explicit access-policy authority/u);
    await service.close();
  });

  it('advances a verified current policy and rejects the old digest immediately', async () => {
    const service = new Rfc64PublicCatalogServiceV1({
      router: new RecordingRouter().asProtocolRouter(),
      controlObjects: controlObjects(),
    });
    service.start();
    const initial = catalogPolicy(CONTEXT_GRAPH_ID, 0, 1);
    const initialDigest = `0x${'32'.repeat(32)}` as Digest32V1;
    service.acceptPolicySnapshot({ policy: initial, policyDigest: initialDigest });
    const successor = {
      ...catalogPolicy(CONTEXT_GRAPH_ID, 0, 0),
      version: '1',
      previousPolicyDigest: initialDigest,
    } satisfies ContextGraphPolicyV1;
    const successorDigest = `0x${'33'.repeat(32)}` as Digest32V1;
    service.acceptPolicySnapshot({ policy: successor, policyDigest: successorDigest });

    await expect(service.announceCatalogHead({
      announcement: announcement(initialDigest),
      peers: [],
    })).rejects.toThrow(/not bound to the locally accepted policy/u);
    await expect(service.announceCatalogHead({
      announcement: announcement(successorDigest),
      peers: [],
    })).resolves.toMatchObject({ announcedPeers: [], failedPeers: [] });
    await service.close();
  });

  it('accepts all four policy cells and requires a roster only for private access', async () => {
    const service = new Rfc64PublicCatalogServiceV1({
      router: new RecordingRouter().asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
    });
    let index = 0;
    for (const accessPolicy of [0, 1] as const) {
      for (const publishPolicy of [0, 1] as const) {
        index += 1;
        const policy = catalogPolicy(
          `${CONTEXT_GRAPH_ID}-${accessPolicy}-${publishPolicy}`,
          accessPolicy,
          publishPolicy,
        );
        const policyDigest = `0x${index.toString(16).padStart(64, '0')}` as Digest32V1;
        const accepted = service.acceptPolicySnapshot({
          policy,
          policyDigest,
          roster: accessPolicy === 1 ? memberRoster(policy, policyDigest) : undefined,
        });
        expect(accepted.policy.accessPolicy).toBe(accessPolicy);
        expect(accepted.policy.publishPolicy).toBe(publishPolicy);
        expect(accepted.roster === null).toBe(accessPolicy === 0);
        expect(service.acceptedPolicyDigestForCatalogScope({
          networkId: policy.networkId,
          contextGraphId: policy.contextGraphId,
          governanceChainId: policy.governanceChainId,
          governanceContractAddress: policy.governanceContractAddress,
          ownershipTransitionDigest: policy.ownershipTransitionDigest,
          subGraphName: 'service-lane',
          authorAddress: OTHER_WALLET.address.toLowerCase() as EvmAddressV1,
          era: policy.era,
          bucketCount: '1',
        })).toBe(policyDigest);
      }
    }
    expect(service.stats().acceptedPolicies).toBe(4);

    const privatePolicy = catalogPolicy(`${CONTEXT_GRAPH_ID}-missing-roster`, 1, 1);
    await expect(Promise.resolve().then(() => service.acceptPolicySnapshot({
      policy: privatePolicy,
      policyDigest: `0x${'f'.repeat(64)}` as Digest32V1,
    }))).rejects.toThrow(/requires a current member roster/);
    await service.close();
  });

  it('rejects a named private current-head lane before router work', async () => {
    const router = new RecordingRouter();
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
    });
    const policy = catalogPolicy(CONTEXT_GRAPH_ID, 1, 1);
    const policyDigest = `0x${'f1'.repeat(32)}` as Digest32V1;
    service.acceptPolicySnapshot({
      policy,
      policyDigest,
      roster: memberRoster(policy, policyDigest),
    });
    service.start();

    await expect(service.discoverCurrentCatalogHead({
      remotePeerId: 'peer-private-provider',
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: 'service-lane',
        authorAddress: AUTHOR,
        catalogEra: '0',
      },
    })).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: 'RFC-64 current-head discovery supports only the root catalog lane',
      }),
    });
    expect(countEvent(
      router,
      `send:${RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1}`,
    )).toBe(0);
    await service.close();
  });

  it('preserves named current-head discovery for public catalogs', async () => {
    const router = new RecordingRouter();
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
    });
    acceptPolicy(service);
    service.start();

    await expect(service.discoverCurrentCatalogHead({
      remotePeerId: 'peer-public-provider',
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: 'service-lane',
        authorAddress: AUTHOR,
        catalogEra: '0',
      },
    })).resolves.toBeNull();
    expect(countEvent(
      router,
      `send:${RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1}`,
    )).toBe(1);
    const sent = router.sends.find(
      ({ protocolId }) => protocolId === RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
    );
    expect(sent).toBeDefined();
    expect(parseRfc64PublicCatalogCurrentHeadQueryV1(sent!.data).subGraphName)
      .toBe('service-lane');
    await service.close();
  });

  it('allows private fan-out only when exact scope-bound native reads are configured', async () => {
    const policy = catalogPolicy(`${CONTEXT_GRAPH_ID}-private-fanout`, 1, 1);
    const policyDigest = `0x${'2b'.repeat(32)}` as Digest32V1;
    const createService = (scopeBound: boolean) => {
      const router = new RecordingRouter();
      router.sendResponse = async () => Uint8Array.of(1);
      const service = new Rfc64PublicCatalogServiceV1({
        router: router.asProtocolRouter(),
        controlObjects: controlObjects(),
        accessPolicyAuthority: {
          localAgentAddress: AUTHOR,
          resolveRemoteAgentAddress: async () => (
            OTHER_WALLET.address.toLowerCase() as EvmAddressV1
          ),
        },
        native: {
          ...nativeOptions(() => inertReconciler()),
          ...(scopeBound ? { resolveScopedReadCapability: async () => null } : {}),
        },
      });
      service.acceptPolicySnapshot({
        policy,
        policyDigest,
        roster: memberRoster(policy, policyDigest),
      });
      service.start();
      return { router, service };
    };
    const unscoped = createService(false);
    await expect(unscoped.service.announceCatalogHead({
      announcement: {
        ...announcement(policyDigest),
        contextGraphId: policy.contextGraphId,
      },
      peers: ['private-provider'],
    })).rejects.toThrow(/requires scope-bound private content transport/u);
    expect(unscoped.router.events.some((event) => event.startsWith('send:'))).toBe(false);
    await unscoped.service.close();

    const scoped = createService(true);
    await expect(scoped.service.announceCatalogHead({
      announcement: {
        ...announcement(policyDigest),
        contextGraphId: policy.contextGraphId,
      },
      peers: ['private-provider'],
    })).resolves.toMatchObject({
      announcedPeers: ['private-provider'],
      failedPeers: [],
    });
    await scoped.service.close();
  });

  it('denies a private-cell author that is absent from the current member roster', async () => {
    const service = new Rfc64PublicCatalogServiceV1({
      router: new RecordingRouter().asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
    });
    service.start();
    const outsider = OTHER_WALLET.address.toLowerCase() as EvmAddressV1;

    const closedPolicy = catalogPolicy(`${CONTEXT_GRAPH_ID}-private-closed`, 1, 1);
    const closedDigest = `0x${'2c'.repeat(32)}` as Digest32V1;
    service.acceptPolicySnapshot({
      policy: closedPolicy,
      policyDigest: closedDigest,
      roster: rosterExcluding(closedPolicy, closedDigest, outsider),
    });

    // Author side (assertAcceptedPolicyMatchesCatalogScope): an accepted private snapshot must not
    // bind a catalog scope whose author is off-roster.
    await expect(service.publishAuthorCatalogGenesis({
      scope: {
        networkId: closedPolicy.networkId,
        contextGraphId: closedPolicy.contextGraphId,
        governanceChainId: closedPolicy.governanceChainId,
        governanceContractAddress: closedPolicy.governanceContractAddress,
        ownershipTransitionDigest: closedPolicy.ownershipTransitionDigest,
        subGraphName: 'service-lane',
        authorAddress: outsider,
        era: '0',
        bucketCount: '1',
      } as AuthorCatalogScopeV1,
      signer: {
        issuer: outsider,
        signDigest: (digest: Uint8Array) => OTHER_WALLET.signMessage(digest),
      },
      issuedAt: HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
      peers: [],
    })).rejects.toThrow(/not bound to the exact catalog network, CG, governance scope, era, and author/);

    // Receive side (#assertAcceptedCatalogAnnouncement): an announcement naming an off-roster author
    // must not resolve a trusted catalog scope.
    await expect(service.announceCatalogHead({
      announcement: {
        ...announcement(closedDigest),
        contextGraphId: closedPolicy.contextGraphId,
        authorAddress: outsider,
      } as Rfc64PublicCatalogHeadAnnouncementV1,
      peers: [],
    })).rejects.toThrow(/not bound to the locally accepted policy snapshot/);

    // Control: the identical announcement is accepted for a private cell whose roster DOES enrol the
    // same author, proving both denials above come from the roster check rather than from an
    // unrelated scope mismatch.
    const openRosterPolicy = catalogPolicy(`${CONTEXT_GRAPH_ID}-private-enrolled`, 1, 1);
    const openRosterDigest = `0x${'2d'.repeat(32)}` as Digest32V1;
    service.acceptPolicySnapshot({
      policy: openRosterPolicy,
      policyDigest: openRosterDigest,
      roster: memberRoster(openRosterPolicy, openRosterDigest),
    });
    await expect(service.announceCatalogHead({
      announcement: {
        ...announcement(openRosterDigest),
        contextGraphId: openRosterPolicy.contextGraphId,
        authorAddress: outsider,
      } as Rfc64PublicCatalogHeadAnnouncementV1,
      peers: [],
    })).resolves.toMatchObject({ announcedPeers: [] });

    await service.close();
  });

  it('publishes exact subgraph genesis under both public policy cells', async () => {
    for (const publishPolicy of [0, 1] as const) {
      const service = new Rfc64PublicCatalogServiceV1({
        router: new RecordingRouter().asProtocolRouter(),
        controlObjects: controlObjects(),
        accessPolicyAuthority: accessPolicyAuthority(),
      });
      service.start();
      const policy = catalogPolicy(
        `${CONTEXT_GRAPH_ID}-public-${publishPolicy}`,
        0,
        publishPolicy,
      );
      const policyDigest = (
        `0x${(10 + publishPolicy).toString(16).padStart(64, '0')}`
      ) as Digest32V1;
      service.acceptPolicySnapshot({ policy, policyDigest });

      const authorAddress = OTHER_WALLET.address.toLowerCase() as EvmAddressV1;
      const result = await service.publishAuthorCatalogGenesis({
        scope: {
          networkId: policy.networkId,
          contextGraphId: policy.contextGraphId,
          governanceChainId: null,
          governanceContractAddress: null,
          ownershipTransitionDigest: null,
          subGraphName: 'service-lane',
          authorAddress,
          era: '0',
          bucketCount: '1',
        },
        signer: {
          issuer: authorAddress,
          signDigest: (digest) => OTHER_WALLET.signMessage(digest),
        },
        issuedAt: HEAD_ISSUED_AT,
        catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
        catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
        peers: [],
      });
      expect(result.announcement).toMatchObject({
        policyDigest,
        subGraphName: 'service-lane',
        authorAddress,
      });
      await service.close();
    }
  });

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
      accessPolicyAuthority: accessPolicyAuthority(),
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
      accessPolicyAuthority: accessPolicyAuthority(),
    });
    service.start();

    await expect(service.publishOpenAuthorCatalogGenesis(genesisInput(service, {
      signer: {
        issuer: OTHER_WALLET.address.toLowerCase(),
        signDigest: (digest: Uint8Array) => OTHER_WALLET.signMessage(digest),
      },
    }) as never)).rejects.toThrow(/signer must equal the exact catalog author/);

    const wrongPolicyPayload = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: OTHER_WALLET.address.toLowerCase() as EvmAddressV1,
    });
    const wrongPolicy = {
      policy: wrongPolicyPayload,
      policyDigest: computeOpenContextGraphPolicyDigestV1(wrongPolicyPayload),
    };
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
      accessPolicyAuthority: accessPolicyAuthority(),
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
      accessPolicyAuthority: accessPolicyAuthority(),
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
      accessPolicyAuthority: accessPolicyAuthority(),
    });
    service.start();

    await expect(service.publishOpenAuthorCatalogGenesis(genesisInput(service)))
      .rejects.toThrow('genesis durability barrier failed');
    expect(store.stageVerifiedObjects).toHaveBeenCalledTimes(2);
    expect(router.events.some((event) => event.startsWith('send:'))).toBe(false);
    await service.close();
  });

  it('reports exact explicit announce ACK/failures and rejects unbounded peers pre-send', async () => {
    const router = new RecordingRouter();
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
    });
    const policy = acceptPolicy(service);
    const head = announcement(policy.policyDigest);
    let attempt = 0;
    router.sendResponse = async () => Uint8Array.of(attempt++ === 0 ? 1 : 2);
    service.start();

    const result = await service.announceCatalogHead({
      announcement: head,
      peers: ['peer-ack', 'peer-fail'],
    });
    expect(result.announcement).toEqual(head);
    expect(result.announcement).not.toBe(head);
    expect(result.announcedPeers).toEqual(['peer-ack']);
    expect(result.failedPeers).toEqual([{
      peerId: 'peer-fail',
      error: expect.stringContaining('invalid acknowledgement'),
    }]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.announcedPeers)).toBe(true);
    expect(Object.isFrozen(result.failedPeers)).toBe(true);

    const sendsBefore = countEvent(
      router,
      `send:${RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1}`,
    );
    await expect(service.announceCatalogHead({
      announcement: head,
      peers: Array.from(
        { length: RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 + 1 },
        (_, index) => `peer-${index}`,
      ),
    })).rejects.toThrow(/at most 64 peers/);
    const sparsePeers = new Array<string>(2);
    sparsePeers[0] = 'peer-ok';
    await expect(service.announceCatalogHead({
      announcement: head,
      peers: sparsePeers,
    })).rejects.toThrow(/peer 1 is invalid/);
    await expect(service.announceCatalogHead({
      announcement: head,
      peers: ['é'.repeat(129)],
    })).rejects.toThrow(/peer 0 is invalid/);
    expect(countEvent(
      router,
      `send:${RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1}`,
    )).toBe(sendsBefore);
    await service.close();
  });

  it('propagates announcement cancellation and skips every later peer', async () => {
    const router = new RecordingRouter();
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
    });
    const policy = acceptPolicy(service);
    const head = announcement(policy.policyDigest);
    const controller = new AbortController();
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    router.sendResponse = async (_protocolId, options, peerId) => {
      expect(peerId).toBe('peer-blocked');
      expect(options?.signal).toBe(controller.signal);
      markFirstEntered();
      return new Promise<Uint8Array>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });
    };
    service.start();

    const announcing = service.announceCatalogHead({
      announcement: head,
      peers: ['peer-blocked', 'peer-must-not-run'],
      signal: controller.signal,
    });
    await firstEntered;
    controller.abort(new Error('repair closing'));
    await expect(announcing).resolves.toMatchObject({
      announcedPeers: [],
      failedPeers: [{ peerId: 'peer-blocked', error: 'repair closing' }],
    });
    expect(router.sends.map(({ peerId }) => peerId)).toEqual(['peer-blocked']);
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
      accessPolicyAuthority: accessPolicyAuthority(),
      transportTimeoutMs: 4_321,
      native: nativeOptions(createReconciler),
    });

    expect(createReconciler).toHaveBeenCalledTimes(1);
    expect(clients).toBeDefined();
    expect(Object.keys(clients!)).toEqual([
      'headTransport',
      'contentTransport',
      'resolveTrustedCatalogScope',
      'verifyIssuerSignature',
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

    const policy = acceptPolicy(service);
    expect(clients!.resolveTrustedCatalogScope(announcement(policy.policyDigest))).toEqual({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    });
    expect(clients!.resolveTrustedCatalogScope({
      ...announcement(policy.policyDigest),
      subGraphName: 'service-lane',
      catalogEra: '7',
    } as Rfc64PublicCatalogHeadAnnouncementV1)).toMatchObject({
      subGraphName: 'service-lane',
      authorAddress: AUTHOR,
      era: '7',
    });
    expect(() => clients!.resolveTrustedCatalogScope(announcement(
      `0x${'cc'.repeat(32)}` as Digest32V1,
    ))).toThrow('no matching accepted policy generation');
    expect(clients!.resolveTrustedCatalogScope({
      ...announcement(policy.policyDigest),
      authorAddress: OTHER_WALLET.address.toLowerCase() as EvmAddressV1,
    })).toMatchObject({
      authorAddress: OTHER_WALLET.address.toLowerCase(),
    });

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
      accessPolicyAuthority: accessPolicyAuthority(),
      native: nativeOptions(() => inertReconciler()),
    });

    service.start();
    expect(router.events.filter((event) => event.startsWith('register:'))).toEqual([
      `register:${RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1}`,
      `register:${RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1}`,
      `register:${RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2}`,
      `register:${RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2}`,
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
      accessPolicyAuthority: accessPolicyAuthority(),
      native: nativeOptions(() => inertReconciler()),
      currentHeadDiscovery: { readCurrentAppliedCatalogHeadDigest: async () => null },
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
    expect(countEvent(
      router,
      `unregister:${RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2}`,
    )).toBe(1);
    expect(countEvent(
      router,
      `unregister:${RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2}`,
    )).toBe(1);
    expect(countEvent(
      router,
      `unregister:${RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1}`,
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
      accessPolicyAuthority: accessPolicyAuthority(),
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
    expect(router.handlers.has(RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2)).toBe(true);
    expect(router.handlers.has(RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2)).toBe(true);

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
      RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2,
      RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2,
    ]) {
      expect(countEvent(router, `unregister:${protocolId}`)).toBe(1);
    }
  });

  it('settles a single-provider synchronization closed when shutdown wins the discovery race', async () => {
    const reconcileHead = vi.fn(async () => 'applied' as const);
    const service = new Rfc64PublicCatalogServiceV1({
      router: new RecordingRouter().asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
      receiver: { retryBackoffMs: 0 },
      native: nativeOptions(() => ({
        isHeadApplied: async () => false,
        reconcileHead,
      })),
    });
    const policy = acceptPolicy(service);
    const current = announcement(policy.policyDigest);
    const discovery = deferred<Readonly<{
      announcement: Rfc64PublicCatalogHeadAnnouncementV1;
      head: never;
    }>>();
    vi.spyOn(service, 'discoverCurrentCatalogHead').mockReturnValue(discovery.promise);

    const synchronization = service.synchronizeCurrentCatalogHead({
      remotePeerId: 'peer-a',
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: AUTHOR,
        era: '0',
      },
    });
    await Promise.resolve();
    await service.close();
    discovery.resolve(Object.freeze({ announcement: current, head: {} as never }));

    const failure = await synchronization.then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Rfc64CatalogReconciliationTerminalErrorV1);
    expect(failure).toMatchObject({ outcome: 'closed', terminalReason: null });
    expect(reconcileHead).not.toHaveBeenCalled();
  });

  it('serializes remote apply before the local-author convergence it triggers', async () => {
    const coordinator = new Rfc64CatalogMutationCoordinatorV1();
    const events: string[] = [];
    const remoteEntered = deferred<void>();
    const releaseRemote = deferred<void>();
    let localProjection: Promise<void> | undefined;
    const catalogScope: AuthorCatalogScopeV1 = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    };
    const service = new Rfc64PublicCatalogServiceV1({
      router: new RecordingRouter().asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
      runCatalogMutationExclusive: (scope, operation, signal) =>
        coordinator.run(scope, operation, signal),
      receiver: {
        retryBackoffMs: 0,
        onHeadApplied: () => {
          localProjection = coordinator.run(
            catalogScope,
            async () => { events.push('local-converged'); },
          );
        },
      },
      native: nativeOptions(() => ({
        isHeadApplied: async () => false,
        reconcileHead: async () => {
          events.push('remote-enter');
          remoteEntered.resolve(undefined);
          await releaseRemote.promise;
          events.push('remote-exit');
          return 'applied';
        },
      })),
    });
    const policy = acceptPolicy(service);
    const current = announcement(policy.policyDigest);
    vi.spyOn(service, 'discoverCurrentCatalogHead').mockResolvedValue(Object.freeze({
      announcement: current,
      head: {} as never,
    }));

    const synchronization = service.synchronizeCurrentCatalogHead({
      remotePeerId: 'peer-a',
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: AUTHOR,
        era: '0',
      },
    });
    await remoteEntered.promise;
    expect(events).toEqual(['remote-enter']);
    releaseRemote.resolve(undefined);
    await synchronization;
    await localProjection;
    expect(events).toEqual(['remote-enter', 'remote-exit', 'local-converged']);
    await service.close();
    await coordinator.closeAndDrain();
  });

  it('selects the highest exact head, retains all matching providers, and fails over', async () => {
    const router = new RecordingRouter();
    const reconciledPeers: string[] = [];
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
      receiver: { maxAttempts: 2, retryBackoffMs: 0 },
      native: nativeOptions(() => ({
        isHeadApplied: async () => false,
        reconcileHead: async (peerId) => {
          reconciledPeers.push(peerId);
          if (peerId === 'peer-a') throw new Error('provider lost');
          return 'applied';
        },
      })),
    });
    const policy = acceptPolicy(service);
    const low = announcement(policy.policyDigest);
    const high = {
      ...low,
      catalogVersion: '1',
      catalogHeadObjectDigest: `0x${'cc'.repeat(32)}` as Digest32V1,
      signatureVariantDigest: `0x${'dd'.repeat(32)}` as Digest32V1,
    } satisfies Rfc64PublicCatalogHeadAnnouncementV1;
    vi.spyOn(service, 'discoverCurrentCatalogHead').mockImplementation(async ({
      remotePeerId,
    }) => Object.freeze({
      announcement: remotePeerId === 'peer-old' ? low : high,
      head: {} as never,
    }));

    await expect(service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: ['peer-a', 'peer-b', 'peer-old'],
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: AUTHOR,
        era: '0',
      },
    })).resolves.toMatchObject({
      current: { announcement: high },
      providerPeerIds: ['peer-a', 'peer-b'],
    });
    expect(reconciledPeers).toEqual(['peer-a', 'peer-b']);
    expect(service.stats().receiver).toMatchObject({
      providerAttempts: 2,
      providerSwitches: 1,
      providerSuccesses: 1,
    });

    const conflicting = {
      ...high,
      catalogHeadObjectDigest: `0x${'ee'.repeat(32)}` as Digest32V1,
    } satisfies Rfc64PublicCatalogHeadAnnouncementV1;
    vi.mocked(service.discoverCurrentCatalogHead).mockImplementation(async ({
      remotePeerId,
    }) => Object.freeze({
      announcement: remotePeerId === 'peer-a' ? high : conflicting,
      head: {} as never,
    }));
    await expect(service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: ['peer-a', 'peer-b'],
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: AUTHOR,
        era: '0',
      },
    })).rejects.toThrow(/conflicting heads/u);
    await service.close();
  });

  it('enforces the 1-8 provider bound and caps discovery concurrency at four', async () => {
    const service = new Rfc64PublicCatalogServiceV1({
      router: new RecordingRouter().asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
      receiver: { retryBackoffMs: 0 },
      native: nativeOptions(() => ({
        isHeadApplied: async () => false,
        reconcileHead: async () => 'applied',
      })),
    });
    const policy = acceptPolicy(service);
    const current = announcement(policy.policyDigest);
    const scope = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0' as const,
    };
    const discovery = vi.spyOn(service, 'discoverCurrentCatalogHead').mockResolvedValue(
      Object.freeze({ announcement: current, head: {} as never }),
    );

    await expect(service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: ['peer-only'],
      scope,
    })).resolves.toMatchObject({ providerPeerIds: ['peer-only'] });
    await expect(service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: [],
      scope,
    })).rejects.toThrow(/1-8 distinct providers/u);
    await expect(service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: Array.from({ length: 9 }, (_, index) => `peer-${index}`),
      scope,
    })).rejects.toThrow(/1-8 distinct providers/u);

    const providers = Array.from({ length: 8 }, (_, index) => `peer-${index}`);
    const gates = providers.map(() => deferred<void>());
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    discovery.mockImplementation(async ({ remotePeerId }) => {
      const index = providers.indexOf(remotePeerId);
      started.push(remotePeerId);
      active += 1;
      peak = Math.max(peak, active);
      try {
        await gates[index]!.promise;
        return Object.freeze({ announcement: current, head: {} as never });
      } finally {
        active -= 1;
      }
    });

    const synchronized = service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: providers,
      scope,
    });
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(peak).toBe(4);
    for (const gate of gates.slice(0, 4)) gate.resolve(undefined);
    await vi.waitFor(() => expect(started).toHaveLength(8));
    expect(peak).toBe(4);
    for (const gate of gates.slice(4)) gate.resolve(undefined);
    await expect(synchronized).resolves.toMatchObject({ providerPeerIds: providers });
    await service.close();
  });

  it('continues discovery through a reachable provider and aggregates only total failure', async () => {
    const reconciledPeers: string[] = [];
    const service = new Rfc64PublicCatalogServiceV1({
      router: new RecordingRouter().asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
      receiver: { retryBackoffMs: 0 },
      native: nativeOptions(() => ({
        isHeadApplied: async () => false,
        reconcileHead: async (peerId) => {
          reconciledPeers.push(peerId);
          return 'applied';
        },
      })),
    });
    const policy = acceptPolicy(service);
    const current = announcement(policy.policyDigest);
    const scope = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0' as const,
    };
    const discovery = vi.spyOn(service, 'discoverCurrentCatalogHead').mockImplementation(
      async ({ remotePeerId }) => {
        if (remotePeerId === 'peer-offline') throw new Error('provider is offline');
        return Object.freeze({ announcement: current, head: {} as never });
      },
    );

    await expect(service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: ['peer-offline', 'peer-live'],
      scope,
    })).resolves.toMatchObject({
      providerPeerIds: ['peer-live'],
      appliedProviderPeerId: 'peer-live',
    });
    expect(reconciledPeers).toEqual(['peer-live']);

    discovery.mockRejectedValue(new Error('all providers are offline'));
    await expect(service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: ['peer-a', 'peer-b'],
      scope,
    })).rejects.toBeInstanceOf(AggregateError);
    await service.close();
  });

  it('classifies the complete provider failure set independently of provider order', async () => {
    const incomplete = (peerId: string) => new Rfc64PublicCatalogNativeReceiverErrorV1(
      'catalog-native-receiver-incomplete',
      `${peerId} does not have the signed bundle`,
    );
    const scenarios = [
      {
        errors: new Map<string, Error>([
          ['peer-a', new Error('peer-a transport timeout')],
          ['peer-b', incomplete('peer-b')],
        ]),
        terminalReason: null,
      },
      {
        errors: new Map<string, Error>([
          ['peer-a', incomplete('peer-a')],
          ['peer-b', new Error('peer-b transport timeout')],
        ]),
        terminalReason: null,
      },
      {
        errors: new Map<string, Error>([
          ['peer-a', incomplete('peer-a')],
          ['peer-b', incomplete('peer-b')],
        ]),
        terminalReason: 'no-authorized-provider',
      },
    ] as const;

    for (const scenario of scenarios) {
      const router = new RecordingRouter();
      const service = new Rfc64PublicCatalogServiceV1({
        router: router.asProtocolRouter(),
        controlObjects: controlObjects(),
        accessPolicyAuthority: accessPolicyAuthority(),
        receiver: { maxAttempts: 1, retryBackoffMs: 0 },
        native: nativeOptions(() => ({
          isHeadApplied: async () => false,
          reconcileHead: async (peerId) => {
            throw scenario.errors.get(peerId)!;
          },
        })),
      });
      const policy = acceptPolicy(service);
      const current = announcement(policy.policyDigest);
      vi.spyOn(service, 'discoverCurrentCatalogHead').mockResolvedValue(Object.freeze({
        announcement: current,
        head: {} as never,
      }));

      const rejection = await service.synchronizeCurrentCatalogHeadFromProviders({
        remotePeerIds: ['peer-a', 'peer-b'],
        scope: {
          networkId: NETWORK_ID,
          contextGraphId: CONTEXT_GRAPH_ID,
          subGraphName: null,
          authorAddress: AUTHOR,
          era: '0',
        },
      }).then(() => null, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(Rfc64CatalogReconciliationTerminalErrorV1);
      expect(rejection).toMatchObject({
        outcome: 'failed',
        terminalReason: scenario.terminalReason,
      });
      const aggregate = (rejection as Error & { readonly cause: unknown }).cause;
      expect(aggregate).toBeInstanceOf(Rfc64CatalogProviderFailureAggregateV1);
      expect(aggregate).toMatchObject({
        attemptedProviderCount: 2,
        providerFailures: [
          { providerPeerId: 'peer-a', error: scenario.errors.get('peer-a') },
          { providerPeerId: 'peer-b', error: scenario.errors.get('peer-b') },
        ],
      });
      expect(classifyRfc64CatalogReconciliationTerminalReasonV1(aggregate))
        .toBe(scenario.terminalReason);
      await service.close();
    }
  });

  it('keeps explicit provider completion separate from a same-head ambient provider', async () => {
    const router = new RecordingRouter();
    const ambientStarted = deferred<void>();
    const releaseAmbient = deferred<void>();
    const reconciledPeers: string[] = [];
    let applied = false;
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
      receiver: { retryBackoffMs: 0 },
      native: nativeOptions(() => ({
        isHeadApplied: async () => applied,
        reconcileHead: async (peerId) => {
          reconciledPeers.push(peerId);
          if (peerId !== 'peer-c') throw new Error('explicit provider must not be needed');
          ambientStarted.resolve(undefined);
          await releaseAmbient.promise;
          applied = true;
          return 'applied';
        },
      })),
    });
    const policy = acceptPolicy(service);
    const current = announcement(policy.policyDigest);
    vi.spyOn(service, 'discoverCurrentCatalogHead').mockResolvedValue(Object.freeze({
      announcement: current,
      head: {} as never,
    }));
    const scope = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0' as const,
    };

    const ambient = service.synchronizeCurrentCatalogHead({
      remotePeerId: 'peer-c',
      scope,
    });
    await ambientStarted.promise;
    const explicit = service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: ['peer-a', 'peer-b'],
      scope,
    });
    await vi.waitFor(() => {
      expect(service.stats().receiver.scheduled).toBe(3);
    });
    releaseAmbient.resolve(undefined);

    await expect(explicit).resolves.toMatchObject({
      providerPeerIds: ['peer-a', 'peer-b'],
      appliedProviderPeerId: null,
    });
    await expect(ambient).resolves.toMatchObject({ announcement: current });
    expect(reconciledPeers).toEqual(['peer-c']);
    await service.close();
  });

  it('rejects a failed mandatory replay of one durable head under a rotated private policy', async () => {
    const router = new RecordingRouter();
    const initialDigest = `0x${'41'.repeat(32)}` as Digest32V1;
    const rotatedDigest = `0x${'42'.repeat(32)}` as Digest32V1;
    const initialPolicy = catalogPolicy(CONTEXT_GRAPH_ID, 1, 1);
    const rotatedPolicy = {
      ...catalogPolicy(CONTEXT_GRAPH_ID, 1, 1),
      version: '1',
      previousPolicyDigest: initialDigest,
    } satisfies ContextGraphPolicyV1;
    const rejectedPrecommit = new Error('current private finalized precommit rejected');
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      accessPolicyAuthority: accessPolicyAuthority(),
      receiver: { maxAttempts: 1, retryBackoffMs: 0 },
      native: nativeOptions(() => ({
        isHeadApplied: async () => false,
        reconcileHead: async (_peerId, head) => {
          if (head.policyDigest === rotatedDigest) throw rejectedPrecommit;
          return 'applied';
        },
      })),
    });
    service.acceptPolicySnapshot({
      policy: initialPolicy,
      policyDigest: initialDigest,
      roster: memberRoster(initialPolicy, initialDigest),
    });
    const sameDurableHead = announcement(initialDigest);
    const discovery = vi.spyOn(service, 'discoverCurrentCatalogHead').mockResolvedValue(
      Object.freeze({ announcement: sameDurableHead, head: {} as never }),
    );
    const scope = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0' as const,
    };
    await expect(service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: ['peer-a'],
      scope,
    })).resolves.toMatchObject({ completionOutcome: 'applied' });

    service.acceptPolicySnapshot({
      policy: rotatedPolicy,
      policyDigest: rotatedDigest,
      roster: memberRoster(rotatedPolicy, rotatedDigest),
    });
    discovery.mockResolvedValue(Object.freeze({
      announcement: { ...sameDurableHead, policyDigest: rotatedDigest },
      head: {} as never,
    }));
    const failedReplay = service.synchronizeCurrentCatalogHeadFromProviders({
      remotePeerIds: ['peer-a', 'peer-b'],
      scope,
    });
    await expect(failedReplay).rejects.toMatchObject({
      message: 'RFC-64 current-head synchronization ended with failed',
      cause: {
        attemptedProviderCount: 2,
        providerFailures: [
          { providerPeerId: 'peer-a', error: rejectedPrecommit },
          { providerPeerId: 'peer-b', error: rejectedPrecommit },
        ],
      },
    });
    await expect(failedReplay).rejects.toHaveProperty(
      'cause',
      expect.any(Rfc64CatalogProviderFailureAggregateV1),
    );
    await service.close();
  });

  it('keeps shadow mode explicitly staged-only even when native activation is available', async () => {
    const router = new RecordingRouter();
    const store = controlObjects();
    const onHeadStaged = vi.fn();
    const reconcileHead = vi.fn(async () => 'applied' as const);
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: store,
      accessPolicyAuthority: accessPolicyAuthority(),
      onHeadStaged,
      resolveContextGraphAuthority: (contextGraphId) => Object.freeze({
        contextGraphId,
        selected: true,
        eligible: true,
        active: true,
        mode: 'shadow',
        killSwitchActive: false,
        legacySyncAllowed: true,
        track2Enabled: true,
        authoringAllowed: true,
        reconciliationLane: 'shadow-stage',
      }),
      native: nativeOptions(() => ({
        isHeadApplied: async () => false,
        reconcileHead,
      })),
    });
    const policy = acceptPolicy(service);
    const produced = await produceEmptyAuthorCatalogGenesisV1({
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
    expect(reconcileHead).not.toHaveBeenCalled();
    expect(service.stats().receiver).toMatchObject({
      stagedOnly: 2,
      applied: 0,
      dedupedAlreadyApplied: 0,
    });
    await service.close();
  });

  it('refuses to stage a governed head under an accepted null-governance policy', async () => {
    const router = new RecordingRouter();
    const store = controlObjects();
    const onError = vi.fn();
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: store,
      accessPolicyAuthority: accessPolicyAuthority(),
      receiver: { maxAttempts: 1, retryBackoffMs: 0, onError },
    });
    const policy = acceptPolicy(service);
    const produced = await produceEmptyAuthorCatalogGenesisV1({
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        governanceChainId: '20430',
        governanceContractAddress: '0x2222222222222222222222222222222222222222',
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
    router.sendResponse = async () => foundResponse;

    service.start();
    await router.invoke(
      RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
      encodeRfc64PublicCatalogHeadAnnouncementV1(head),
    );
    await service.whenReceiverIdle();

    expect(store.stageVerifiedObjects).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(service.stats().receiver).toMatchObject({
      stagedOnly: 0,
      applied: 0,
      failed: 1,
    });
    await service.close();
  });
});
