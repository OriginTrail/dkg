/**
 * A real agent whose author catalog is grown through its own observer, supervisor, upsert and
 * successor producer, with its durable stores counted and nothing replaced.
 */
import {
  contextGraphAssertionUri,
  createOperationContext,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  type AssertionSeal,
  type AuthorCatalogScopeV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { vi } from 'vitest';

import type { DKGAgent } from '../../src/index.js';
import { loadBoundedAuthorCatalogHistoryV1 } from '../../src/dkg-agent-rfc64-catalog.js';
import { readVerifiedRfc64CatalogMutationStateV1 } from '../../src/internal/catalog-mutation-memory.js';
import type { Rfc64PersistenceV1 } from '../../src/rfc64/persistence-v1.js';
import type { Rfc64PublicCatalogSuccessorAssetInputV1 } from
  '../../src/rfc64/public-catalog-successor-producer-v1.js';
import {
  AUTHOR,
  AUTHOR_WALLET,
  CONTEXT_GRAPH_ID,
  NATIVE_DEPLOYMENT,
  NETWORK_ID,
  PROJECTION_QUADS,
  authorSealV1,
  catalogScopeDigestV1,
  seedInventoryAssetV1,
  startRepairAgentV1,
} from './rfc64-local-catalog-repair-fixture.js';

export const PLACEMENT_SCOPE = Object.freeze({
  networkId: NETWORK_ID,
  contextGraphId: CONTEXT_GRAPH_ID,
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
}) as AuthorCatalogScopeV1;
export const PLACEMENT_DELEGATION_EXPIRES_AT = '1893456000000' as TimestampMsV1;
export const PLACEMENT_MUTATION = Object.freeze({
  scope: PLACEMENT_SCOPE,
  author: AUTHOR_WALLET,
  deployment: NATIVE_DEPLOYMENT,
  peers: [] as readonly string[],
  catalogIssuerDelegationEffectiveAt: '0' as TimestampMsV1,
  catalogIssuerDelegationExpiresAt: PLACEMENT_DELEGATION_EXPIRES_AT,
});
export const PLACEMENT_PROJECTION = encodeCanonicalCgSharedPublicRootProjectionV1(PROJECTION_QUADS);
export const PLACEMENT_SCOPE_DIGEST = catalogScopeDigestV1();

/**
 * An author on an open policy. By default only the confirmed repair places a row, as on a
 * finalized-private lane: the share-time projection is switched off and the lane accepts the
 * repair. With `shareTimeProjection` the lane is the public one it resolves to, and every shared
 * asset is projected into the catalog by the real projection.
 */
export async function startPlacementAgentV1(
  name: string,
  options: Readonly<{ shareTimeProjection?: boolean; dataDir?: string; storePath?: string }> = {},
): Promise<DKGAgent> {
  const agent = await startRepairAgentV1({
    name,
    dataDir: options.dataDir,
    storePath: options.storePath,
    autoPublish: {
      peers: [],
      catalogIssuerDelegationExpiresAt: PLACEMENT_DELEGATION_EXPIRES_AT,
    },
  });
  vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
  agent.acceptOpenContextGraphPolicyV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR,
  });
  if (options.shareTimeProjection === true) return agent;
  vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1').mockResolvedValue(null);
  const realLane = (agent as any).resolveRfc64CatalogAuthoringLaneV1.bind(agent);
  vi.spyOn(agent as any, 'resolveRfc64CatalogAuthoringLaneV1').mockImplementation(
    (contextGraphId: unknown, subGraphName: unknown) => {
      const lane = realLane(contextGraphId, subGraphName);
      return lane === null ? null : { ...lane, acceptsFinalizedVmRepair: true };
    },
  );
  return agent;
}

/** Observe one chain confirmation and let the placement it asks for run to its end. */
export async function observeConfirmationV1(
  agent: DKGAgent,
  suffix: string,
  seal: AssertionSeal,
): Promise<void> {
  await agent.observeRfc64ConfirmedVmV1({
    contextGraphId: CONTEXT_GRAPH_ID,
    assertionCoordinate: `repair-${suffix}`,
    shareOperationId: `repair-operation-${suffix}`,
    seal,
    assertionUri: contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, `repair-${suffix}`),
    ctx: createOperationContext('publishFromSWM', `job-${suffix}`),
    publicationLabel: 'queued publish',
  });
  // Whether or not the observer waits for the placement, the supervisor has finished it here.
  await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
}

/** Share an asset: its durable workspace copy and its author-inventory row. */
export async function shareAssetV1(agent: DKGAgent, kaNumber: number): Promise<AssertionSeal> {
  const { seal } = await seedInventoryAssetV1(agent, `reuse-${kaNumber}`, BigInt(kaNumber));
  await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
  return seal;
}

/** Share an asset and observe its chain confirmation: one placement through the supervisor. */
export async function placeAssetV1(agent: DKGAgent, kaNumber: number): Promise<AssertionSeal> {
  const seal = await shareAssetV1(agent, kaNumber);
  await observeConfirmationV1(agent, `reuse-${kaNumber}`, seal);
  return seal;
}

export async function placementAssetV1(
  kaNumber: number,
  assertionVersion = '1',
): Promise<Rfc64PublicCatalogSuccessorAssetInputV1> {
  return Object.freeze({
    assertionCoordinate: `upsert-${kaNumber}` as never,
    projectionBytes: PLACEMENT_PROJECTION,
    seal: await authorSealV1(BigInt(kaNumber), assertionVersion),
  });
}

export function upsertPlacementV1(
  agent: DKGAgent,
  placed: Rfc64PublicCatalogSuccessorAssetInputV1,
  overrides: Readonly<{ author?: unknown; peers?: readonly string[] }> = {},
) {
  return agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({
    ...PLACEMENT_MUTATION,
    ...(overrides.peers === undefined ? {} : { peers: overrides.peers }),
    author: (overrides.author ?? AUTHOR_WALLET) as never,
    asset: placed,
  });
}

export function appliedPlacementHeadV1(agent: DKGAgent) {
  return agent.readRfc64AppliedCatalogHeadV1({
    catalogScopeDigest: PLACEMENT_SCOPE_DIGEST,
    authorAddress: AUTHOR,
  });
}

export function placementPersistenceV1(agent: DKGAgent): Rfc64PersistenceV1 {
  return (agent as any).rfc64PersistenceV1;
}

export function placementPolicyDigestV1(agent: DKGAgent): string {
  return (agent as any).rfc64PublicCatalogServiceV1.acceptedPolicyDigestForCatalogScope(PLACEMENT_SCOPE);
}

/**
 * Count what the agent reads from its durable stores from now on. `failNextCas` fails one
 * applied-head CAS, `afterNextCas` runs once right after the next one that succeeds, with the
 * digest of the head it applied, and `onReset` runs with every `reset`. `lose` makes one stored
 * bundle or control object read as absent, as it would after its file was removed, until it is
 * staged again or `restore`d; `spoil` makes one control object unreadable, as it would be if its
 * file no longer held what its digest names.
 */
export function watchPlacementStoresV1(agent: DKGAgent, onReset: () => void = () => {}) {
  const real = placementPersistenceV1(agent);
  const reads = { bundles: 0, controlObjects: 0, appliedHead: 0, inventorySnapshot: 0, cas: 0 };
  const lost = new Set<string>();
  const spoilt = new Set<string>();
  const stagedAgain: string[] = [];
  /** Null for a lost control object, a rejection for a spoilt one, undefined for one to read. */
  const stored = (digest: string): null | undefined => {
    if (spoilt.has(digest)) throw new Error(`[control-store-corrupt] stored control object ${digest} does not verify`);
    return lost.has(digest) ? null : undefined;
  };
  let casFailure: Error | undefined;
  let afterCas: ((committedHeadDigest: string) => void) | undefined;
  const views: Record<string, unknown> = {
    kaBundles: {
      ...real.kaBundles,
      readKaBundleByDigest: async (...args: Parameters<typeof real.kaBundles.readKaBundleByDigest>) => {
        reads.bundles += 1;
        return lost.has(args[0]) ? null : real.kaBundles.readKaBundleByDigest(...args);
      },
      putKaBundle: async (...args: Parameters<typeof real.kaBundles.putKaBundle>) => {
        const receipt = await real.kaBundles.putKaBundle(...args);
        if (lost.delete(args[0].blobDigest)) stagedAgain.push(args[0].blobDigest);
        return receipt;
      },
    },
    controlObjects: {
      ...real.controlObjects,
      getVerifiedObject: async (...args: Parameters<typeof real.controlObjects.getVerifiedObject>) => {
        reads.controlObjects += 1;
        const absent = stored(args[0].objectDigest);
        return absent === null ? null : real.controlObjects.getVerifiedObject(...args);
      },
      getVerifiedObjectByDigest: async (
        ...args: Parameters<typeof real.controlObjects.getVerifiedObjectByDigest>
      ) => {
        reads.controlObjects += 1;
        const absent = stored(args[0].objectDigest);
        return absent === null ? null : real.controlObjects.getVerifiedObjectByDigest(...args);
      },
    },
    inventory: {
      ...real.inventory,
      readAppliedCatalogHeadV1: (...args: Parameters<typeof real.inventory.readAppliedCatalogHeadV1>) => {
        reads.appliedHead += 1;
        return real.inventory.readAppliedCatalogHeadV1(...args);
      },
      compareAndSwapAppliedCatalogHeadV1: (
        ...args: Parameters<typeof real.inventory.compareAndSwapAppliedCatalogHeadV1>
      ) => {
        reads.cas += 1;
        if (casFailure !== undefined) {
          const failure = casFailure;
          casFailure = undefined;
          throw failure;
        }
        const committed = real.inventory.compareAndSwapAppliedCatalogHeadV1(...args);
        const then = afterCas;
        afterCas = undefined;
        then?.(args[0].currentCatalogHeadDigest);
        return committed;
      },
    },
    swmAuthorInventory: {
      ...real.swmAuthorInventory,
      readSwmAuthorInventorySnapshotV1: (
        ...args: Parameters<typeof real.swmAuthorInventory.readSwmAuthorInventorySnapshotV1>
      ) => {
        reads.inventorySnapshot += 1;
        return real.swmAuthorInventory.readSwmAuthorInventorySnapshotV1(...args);
      },
    },
  };
  (agent as any).rfc64PersistenceV1 = new Proxy(real, {
    get(target, property) {
      if (typeof property === 'string' && Object.hasOwn(views, property)) return views[property];
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    reads,
    reset(): void {
      for (const key of Object.keys(reads) as (keyof typeof reads)[]) reads[key] = 0;
      onReset();
    },
    failNextCas(failure: Error): void {
      casFailure = failure;
    },
    afterNextCas(then: (committedHeadDigest: string) => void): void {
      afterCas = then;
    },
    lose(digest: string): void {
      lost.add(digest);
    },
    spoil(digest: string): void {
      spoilt.add(digest);
    },
    restore(digest: string): void {
      lost.delete(digest);
      spoilt.delete(digest);
    },
    /** Bundles that were lost and that the agent has put back since. */
    stagedAgain,
  };
}

/** The signed head, directory root and bucket the agent's applied head names. */
export async function appliedCatalogObjectsV1(agent: DKGAgent) {
  const persistence = placementPersistenceV1(agent);
  const state = await readVerifiedRfc64CatalogMutationStateV1(persistence, appliedPlacementHeadV1(agent)!);
  return {
    state,
    history: await loadBoundedAuthorCatalogHistoryV1(persistence, state.previousHead),
  };
}

export function kaNumbersV1(assets: readonly Rfc64PublicCatalogSuccessorAssetInputV1[]): string[] {
  return assets.map(({ seal }) => `${seal.kaUal.split('/').at(-1)}@${seal.assertionVersion}`);
}
