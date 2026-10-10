/**
 * GH#3134 — a full author catalog on a real agent: the real observer, supervisor, placement
 * repair, upsert, successor producer, signer and stores.
 *
 * How the fixture gets to the cap: the agent's modules read the row cap from the core package, and
 * this file gives them 4 in place of 1,024 (core's own producer keeps enforcing 1,024, which a
 * four-row catalog never meets). Four real placements then fill a real catalog, so every refusal,
 * replacement and removal below runs through production code on a catalog that is at its cap. The
 * rule at the real cap is covered on synthetic rows in `rfc64-author-catalog-capacity.test.ts`,
 * `rfc64-catalog-upsert-planner-v1.test.ts` and `rfc64-full-catalog-parking.test.ts`.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@origintrail-official/dkg-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return { ...actual, MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1: 4 };
});

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  contextGraphAssertionUri,
  createOperationContext,
  type AssertionSeal,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';

import type { DKGAgent } from '../src/index.js';
import { AuthorCatalogFullErrorV1 } from '../src/internal/author-catalog-capacity.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from
  '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import {
  AUTHOR,
  AUTHOR_WALLET,
  CONTEXT_GRAPH_ID,
  NATIVE_DEPLOYMENT,
  NETWORK_ID,
  agents,
  authorSealV1,
  bootstrapConfigV1,
  catalogScopeDigestV1,
  seedInventoryAssetV1,
  startRepairAgentV1,
  tempDirs,
} from './support/rfc64-local-catalog-repair-fixture.js';

const CAP = 4;
const AUTO_PUBLISH = {
  peers: [],
  catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
};
/** The canonical bytes of the fixture's projection, which every fixture seal attests. */
const PROJECTION = new TextEncoder().encode(
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
);
const SCOPE = Object.freeze({
  networkId: NETWORK_ID,
  contextGraphId: CONTEXT_GRAPH_ID,
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
} as const);

type CatalogAsset = Parameters<DKGAgent['upsertConfirmedRfc64PublicRootCatalogAssetV1']>[0]['asset'];
type Marker = Rfc64FinalizedPrivatePlacementRepairV1;

/**
 * An author whose lane behaves as a finalized-chain private lane does: confirmed placements go
 * through the placement repair, and the share-time projection keeps every row it ever placed.
 * The ordinary projection is switched off until a row asks for it, so only what a row does places
 * a catalog row. The graph's policy is accepted from the node's configuration while it starts and
 * the agent is instrumented before that, so a restarted author's first supervisor pass is the one
 * a restarted node runs, and it is observed.
 */
async function startAuthor(name: string, persisted?: Readonly<{ dataDir: string; storePath: string }>) {
  let instrumented!: ReturnType<typeof instrument>;
  const agent = await startRepairAgentV1({
    name,
    ...persisted,
    autoPublish: AUTO_PUBLISH,
    bootstrap: bootstrapConfigV1(undefined, false),
    beforeStart: (starting) => { instrumented = instrument(starting); },
  });
  await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
  return instrumented;
}

function instrument(agent: DKGAgent) {
  const internals = agent as unknown as Record<string, (...args: any[]) => any>;
  vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
  const projection = vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1').mockResolvedValue(null);
  const realLane = internals.resolveRfc64CatalogAuthoringLaneV1!.bind(agent);
  vi.spyOn(internals, 'resolveRfc64CatalogAuthoringLaneV1').mockImplementation(
    (contextGraphId: unknown, subGraphName: unknown) => {
      const lane = realLane(contextGraphId, subGraphName);
      return lane === null
        ? null
        : { ...lane, acceptsFinalizedVmRepair: true, projectionTargetPolicy: 'monotonic-union' };
    },
  );

  // What a mutation would build, sign, commit or announce. Every spy passes through.
  const seen = {
    placementAttempts: [] as string[],
    successorAssets: [] as (readonly CatalogAsset[])[],
    signatures: 0,
    announcements: 0,
    catalogReads: 0,
  };
  const realPlacement = internals.publishRfc64FinalizedPrivateCatalogPlacementV1!.bind(agent);
  vi.spyOn(internals, 'publishRfc64FinalizedPrivateCatalogPlacementV1').mockImplementation(
    (params: { kaUal: string }, placement: unknown) => {
      seen.placementAttempts.push(params.kaUal);
      return realPlacement(params, placement);
    },
  );
  const realSuccessor = agent.publishAuthorCatalogExactSetSuccessorV1.bind(agent);
  vi.spyOn(agent, 'publishAuthorCatalogExactSetSuccessorV1').mockImplementation((input) => {
    seen.successorAssets.push(input.assets as readonly CatalogAsset[]);
    return realSuccessor(input);
  });
  const realSigner = agent.createRfc64CatalogAuthorSignerV1.bind(agent);
  vi.spyOn(agent, 'createRfc64CatalogAuthorSignerV1').mockImplementation((address, signal) => {
    const signer = realSigner(address, signal);
    return Object.freeze({
      address: signer.address,
      signMessage: (message: Uint8Array) => {
        seen.signatures += 1;
        return signer.signMessage(message);
      },
    });
  });
  // A committed head leaves through one of these, whichever this build has.
  for (const announce of ['announceRfc64PublicCatalogHeadV1', 'deliverRfc64CatalogHeadV1']) {
    const real = internals[announce];
    if (typeof real !== 'function') continue;
    vi.spyOn(internals, announce).mockImplementation((...args: unknown[]) => {
      seen.announcements += 1;
      return real.apply(agent, args);
    });
  }
  const realStateRead = internals.readRfc64CatalogMutationStateV1!.bind(agent);
  vi.spyOn(internals, 'readRfc64CatalogMutationStateV1').mockImplementation((...args: unknown[]) => {
    seen.catalogReads += 1;
    return realStateRead(...args);
  });
  const warn = vi.spyOn((agent as unknown as { log: { warn: (...args: unknown[]) => void } }).log, 'warn');
  const lines = (event: string): Record<string, unknown>[] => warn.mock.calls.flatMap(([, message]) => {
    try {
      const line = JSON.parse(String(message)) as Record<string, unknown>;
      return line.event === event ? [line] : [];
    } catch {
      return [];
    }
  });

  return {
    agent,
    seen,
    lines,
    projection,
    markers: (): readonly Marker[] => (agent as unknown as {
      rfc64PersistenceV1: { finalizedPrivatePlacementRepairs: { list(): readonly Marker[] } };
    }).rfc64PersistenceV1.finalizedPrivatePlacementRepairs.list(),
    head: () => agent.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigestV1(),
      authorAddress: AUTHOR,
    }),
    capacity: () => agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.authorCatalogCapacity,
    /** What a refusal must leave untouched. */
    footprint: () => ({
      successors: seen.successorAssets.length,
      signatures: seen.signatures,
      announcements: seen.announcements,
      head: agent.readRfc64AppliedCatalogHeadV1({
        catalogScopeDigest: catalogScopeDigestV1(),
        authorAddress: AUTHOR,
      }),
    }),
    /** One supervisor pass now. */
    pass: async () => {
      agent.startRfc64SwmCatalogProjectionSupervisorV1(createOperationContext('system'));
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    },
    /** The post-confirmation observer for one seeded asset, then the supervisor at rest. */
    confirm: async (suffix: string, seal: AssertionSeal) => {
      await agent.observeRfc64ConfirmedVmV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        assertionCoordinate: `repair-${suffix}`,
        shareOperationId: `repair-operation-${suffix}`,
        seal,
        assertionUri: contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, `repair-${suffix}`),
        ctx: createOperationContext('publishFromSWM', `job-${suffix}`),
        publicationLabel: 'queued publish',
      });
      await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    },
  };
}

/** A catalog asset the upsert is handed directly: a real seal over the fixture projection. */
async function heldAsset(kaNumber: bigint, assertionVersion = '1'): Promise<CatalogAsset> {
  const seal = await authorSealV1(kaNumber);
  return Object.freeze({
    assertionCoordinate: `held-${kaNumber}`,
    projectionBytes: PROJECTION,
    seal: Object.freeze({ ...seal, assertionVersion }),
  }) as unknown as CatalogAsset;
}

function upsertParams(seen: { signatures: number }) {
  return {
    scope: SCOPE,
    author: Object.freeze({
      address: AUTHOR,
      signMessage: (message: Uint8Array) => {
        seen.signatures += 1;
        return AUTHOR_WALLET.signMessage(message);
      },
    }),
    deployment: NATIVE_DEPLOYMENT,
    peers: [],
    catalogIssuerDelegationEffectiveAt: '0' as TimestampMsV1,
    catalogIssuerDelegationExpiresAt: AUTO_PUBLISH.catalogIssuerDelegationExpiresAt,
  };
}

describe('a full author catalog', () => {
  it('reads the lowered cap everywhere the agent reads it', () => {
    expect(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1).toBe(CAP);
    expect(new AuthorCatalogFullErrorV1([], 1).rowCap).toBe(CAP);
  });

  it('refuses a new asset on the single-asset upsert before anything is built, and still replaces and removes', async () => {
    const author = await startAuthor('full-catalog-upsert');
    const params = upsertParams(author.seen);
    const held = await Promise.all([1n, 2n, 3n, 4n].map((kaNumber) => heldAsset(kaNumber)));
    for (const asset of held) await author.agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({ ...params, asset });
    expect(author.head()).toMatchObject({ inventoryRowCount: String(CAP), catalogVersion: '4' });

    const before = author.footprint();
    const newAsset = await heldAsset(5n);
    const refusal = await author.agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({ ...params, asset: newAsset })
      .then(() => undefined, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(AuthorCatalogFullErrorV1);
    expect(refusal).toMatchObject({
      code: 'catalog-full',
      rowCount: CAP,
      rowCap: CAP,
      newRows: 1,
      appliedHeadDigest: before.head?.currentCatalogHeadDigest,
    });
    expect([...(refusal as AuthorCatalogFullErrorV1).heldKaUals].sort())
      .toEqual(held.map((asset) => asset.seal.kaUal).sort());
    // Nothing was built, signed, committed or announced.
    expect(author.footprint()).toEqual(before);

    // A newer version of an asset the catalog holds replaces its row at the cap.
    await expect(author.agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({
      ...params,
      asset: await heldAsset(2n, '2'),
    })).resolves.toMatchObject({ inventoryRowCount: String(CAP), catalogVersion: '5' });
    await expect(author.agent.rfc64CatalogCoversConfirmedSwmRowV1({
      scope: SCOPE,
      expectedRow: {
        kaUal: held[1]!.seal.kaUal,
        assertionCoordinate: held[1]!.assertionCoordinate,
        assertionVersion: '2',
        sealDigest: `0x${'00'.repeat(32)}`,
      } as never,
    })).resolves.toBe(false);
    expect(author.seen.successorAssets.at(-1)?.map((asset) => asset.seal.assertionVersion).sort())
      .toEqual(['1', '1', '1', '2']);

    // A removal works at the cap, and frees the row the refused asset then takes.
    await expect(author.agent.reconcileRfc64PublicRootCatalogExactSetV1({
      ...params,
      assets: author.seen.successorAssets.at(-1)!.filter((asset) => asset.seal.kaUal !== held[3]!.seal.kaUal),
    })).resolves.toMatchObject({ status: 'advanced', successorsApplied: 1, appliedHead: { inventoryRowCount: '3' } });
    await expect(author.agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({ ...params, asset: newAsset }))
      .resolves.toMatchObject({ inventoryRowCount: String(CAP) });
  }, 60_000);

  it('refuses the share-time projection of a new asset with its own diagnostic kind, and does not retry it on the timer', async () => {
    const author = await startAuthor('full-catalog-projection');
    const params = upsertParams(author.seen);
    for (const kaNumber of [1n, 2n, 3n, 4n]) {
      await author.agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({ ...params, asset: await heldAsset(kaNumber) });
    }
    author.projection.mockRestore();
    const startedAt = Date.now();
    // A share, as the share-time observer does it: the signed inventory row, then the projection
    // request. Returns what the projection must leave untouched when it is refused.
    const share = async (suffix: string, kaNumber: bigint) => {
      await seedInventoryAssetV1(author.agent, suffix, kaNumber);
      const beforeProjection = author.footprint();
      expect(author.agent.requestRfc64SwmCatalogProjectionV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        authorAddress: AUTHOR,
      })).toBe(true);
      await author.agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
      return beforeProjection;
    };

    // The author shares a new asset: its inventory now names a row the catalog cannot take.
    const before = await share('shared-new', 50n);

    const repair = () => author.agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()!.repairs[0]!;
    expect(repair()).toMatchObject({
      outcome: 'failed',
      lastError: 'RFC-64 catalog repair catalog_full (stage: unknown)',
      diagnostic: { kind: 'catalog_full' },
    });
    // Parked for the long interval, not the failure back-off.
    expect(repair().nextAttemptAtMs).toBeGreaterThanOrEqual(startedAt + 60 * 60_000);
    expect(author.capacity()).toEqual({ parkedPlacements: 0, scopesAtCap: 1 });
    expect(author.lines('catalog_full')).toEqual([{
      event: 'catalog_full',
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      refused: 'projection',
      rows: CAP,
      rowCap: CAP,
      parkedPlacements: 0,
    }]);
    expect(author.lines('catalog_repair_failed')).toEqual([]);
    expect(author.footprint()).toEqual(before);

    // Each change of the inventory still gets its one attempt. Once the inventory itself has
    // more rows than a catalog holds, the projection is refused before the catalog is even read.
    const attemptsBefore = repair().attempts;
    const readsBefore: number[] = [];
    for (const [index, kaNumber] of [51n, 52n, 53n, 54n].entries()) {
      readsBefore.push(author.seen.catalogReads);
      const beforeProjection = await share(`shared-more-${index}`, kaNumber);
      expect(repair()).toMatchObject({ outcome: 'failed', diagnostic: { kind: 'catalog_full' } });
      expect(author.footprint()).toEqual(beforeProjection);
    }
    expect(repair().attempts).toBe(attemptsBefore + 4);
    const reads = [...readsBefore.slice(1), author.seen.catalogReads].map((count, index) => count - readsBefore[index]!);
    // Inventories of 2, 3 and 4 rows are compared with the catalog; the 5-row one is not.
    expect(reads).toEqual([1, 1, 1, 0]);
    expect(author.head()).toEqual(before.head);
    expect(author.seen.successorAssets).toHaveLength(before.successors);
    expect(author.lines('catalog_full')).toHaveLength(1);
    expect(author.lines('catalog_repair_failed')).toEqual([]);
  }, 60_000);

  it('parks a confirmed placement its catalog has no row for, and places it after a removal', async () => {
    const author = await startAuthor('full-catalog-placement');
    const seals: AssertionSeal[] = [];
    for (let index = 0; index < CAP + 2; index++) {
      seals.push((await seedInventoryAssetV1(author.agent, `asset-${index}`, BigInt(61 + index))).seal);
    }
    for (let index = 0; index < CAP; index++) await author.confirm(`asset-${index}`, seals[index]!);
    expect(author.head()).toMatchObject({ inventoryRowCount: String(CAP) });
    expect(author.markers()).toEqual([]);
    expect(author.capacity()).toEqual({ parkedPlacements: 0, scopesAtCap: 0 });

    // The fifth confirmed asset: the publication's observer returns, the placement is refused.
    const before = author.footprint();
    await author.confirm(`asset-${CAP}`, seals[CAP]!);
    expect(author.seen.placementAttempts.slice(CAP)).toEqual([seals[CAP]!.kaUal]);
    expect(author.markers().map(({ kaUal }) => kaUal)).toEqual([seals[CAP]!.kaUal]);
    expect(author.footprint()).toEqual(before);
    expect(author.capacity()).toEqual({ parkedPlacements: 1, scopesAtCap: 1 });
    expect(author.lines('catalog_full')).toEqual([{
      event: 'catalog_full',
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      refused: 'placement',
      rows: CAP,
      rowCap: CAP,
      parkedPlacements: 1,
    }]);
    expect(author.lines('catalog_private_repair_failed')).toEqual([]);

    // The sixth is parked on what that refusal found: no attempt and no catalog read of its own.
    const readsBefore = author.seen.catalogReads;
    await author.confirm(`asset-${CAP + 1}`, seals[CAP + 1]!);
    for (let pass = 0; pass < 3; pass++) await author.pass();
    expect(author.seen.placementAttempts).toHaveLength(CAP + 1);
    expect(author.seen.catalogReads).toBe(readsBefore);
    expect(author.markers()).toHaveLength(2);
    expect(author.footprint()).toEqual(before);
    expect(author.capacity()).toEqual({ parkedPlacements: 2, scopesAtCap: 1 });
    expect(author.lines('catalog_full')).toHaveLength(1);

    // A removal frees a row: the next pass attempts both, places one and parks the other again.
    const params = upsertParams(author.seen);
    await expect(author.agent.reconcileRfc64PublicRootCatalogExactSetV1({
      ...params,
      assets: author.seen.successorAssets.at(-1)!.slice(1),
    })).resolves.toMatchObject({ status: 'advanced', successorsApplied: 1, appliedHead: { inventoryRowCount: '3' } });
    expect(author.capacity()).toEqual({ parkedPlacements: 0, scopesAtCap: 0 });
    await author.pass();

    expect(author.seen.placementAttempts).toHaveLength(CAP + 3);
    expect(author.head()).toMatchObject({ inventoryRowCount: String(CAP) });
    const [parked] = author.markers();
    expect(author.markers()).toHaveLength(1);
    const placedKaUal = [seals[CAP]!.kaUal, seals[CAP + 1]!.kaUal].find((kaUal) => kaUal !== parked!.kaUal);
    expect(author.seen.successorAssets.at(-1)!.map((asset) => asset.seal.kaUal)).toContain(placedKaUal);
    expect(author.capacity()).toEqual({ parkedPlacements: 1, scopesAtCap: 1 });
    for (let pass = 0; pass < 3; pass++) await author.pass();
    expect(author.seen.placementAttempts).toHaveLength(CAP + 3);
  }, 90_000);

  it('keeps placements parked across a restart, with one attempt for the catalog and none a marker', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-full-catalog-restart-'));
    tempDirs.push(dataDir);
    const persisted = { dataDir, storePath: join(dataDir, 'oxigraph') };
    const first = await startAuthor('full-catalog-restart-first', persisted);
    const seals: AssertionSeal[] = [];
    for (let index = 0; index < CAP + 3; index++) {
      seals.push((await seedInventoryAssetV1(first.agent, `asset-${index}`, BigInt(71 + index))).seal);
    }
    for (let index = 0; index < CAP + 3; index++) await first.confirm(`asset-${index}`, seals[index]!);
    expect(first.head()).toMatchObject({ inventoryRowCount: String(CAP) });
    expect(first.markers()).toHaveLength(3);
    expect(first.capacity()).toEqual({ parkedPlacements: 3, scopesAtCap: 1 });
    const headBefore = first.head();
    await first.agent.stop();
    agents.splice(agents.indexOf(first.agent), 1);

    // The restarted node lists the three markers in its first pass, on its own.
    const restarted = await startAuthor('full-catalog-restart-second', persisted);

    expect(restarted.markers()).toHaveLength(3);
    expect(restarted.seen.placementAttempts).toHaveLength(1);
    expect(restarted.seen.successorAssets).toEqual([]);
    expect(restarted.seen.signatures).toBe(0);
    expect(restarted.seen.announcements).toBe(0);
    expect(restarted.head()).toEqual(headBefore);
    expect(restarted.capacity()).toEqual({ parkedPlacements: 3, scopesAtCap: 1 });
    expect(restarted.lines('catalog_full')).toEqual([expect.objectContaining({ parkedPlacements: 3 })]);
    for (let pass = 0; pass < 3; pass++) await restarted.pass();
    expect(restarted.seen.placementAttempts).toHaveLength(1);
  }, 90_000);
});
