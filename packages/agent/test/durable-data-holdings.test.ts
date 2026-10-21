import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
  overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { getSyncCheckpointKey, MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import {
  createGraphScopedDurableManifestPlan,
  graphScopedDurableManifestPrefixAtOffset,
  type GraphScopedDurableManifestPlan,
} from '../src/sync/durable-integrity.js';
import { createDurableSyncAccumulator, finalizeDurableSyncCompletion } from '../src/sync/durable-progress.js';
import {
  describeDurableHoldingsPlan,
  planDurableDataFromHoldings,
  planDurableDataFromLocalHoldings,
  readHeldGraphScopedAssets,
  settleHeldDurableData,
  type DurableHoldingsChannel,
} from '../src/sync/requester/durable-data-holdings.js';
import { materializeVerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { partitionVerifiedGraphScopedAssets } from '../src/sync/requester/verified-asset-preparation.js';

const CG = 'held-generation-cg';
const stores: OxigraphStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

interface AssetFixture {
  readonly ual: string;
  readonly graph: string;
  readonly payload: Quad[];
  readonly meta: Quad[];
}

/** One graph-scoped asset as a peer serves it: its public rows and its META envelope. */
function asset(kaNumber: number, options: { version?: string; rows?: number; value?: string } = {}): AssetFixture {
  const version = options.version ?? '1';
  const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ef/${kaNumber}`;
  const graph = knowledgeAssetLayerGraphUri(
    CG,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(ual, version),
  );
  const payload = Array.from({ length: options.rows ?? 3 }, (_, index): Quad => ({
    subject: `urn:held:${kaNumber}:${index}`,
    predicate: 'urn:held:value',
    object: `"${options.value ?? 'v1'}-${index}"`,
    graph,
  }));
  const meta = generateGraphKnowledgeAssetMetadata({
    ual,
    contextGraphId: CG,
    merkleRoot: computeFlatKCRootV10(payload, []),
    publisherPeerId: 'publisher-peer',
    accessPolicy: 'public',
    timestamp: new Date(0),
    assertionVersion: version,
    publicTripleCount: payload.length,
    privateTripleCount: 0,
    assertionGraph: graph,
  }, { status: 'tentative' });
  return { ual, graph, payload, meta };
}

function manifestOf(fixtures: readonly AssetFixture[]): GraphScopedDurableManifestPlan {
  const manifest = createGraphScopedDurableManifestPlan(fixtures.flatMap((fixture) => fixture.meta), CG);
  if (!manifest) throw new Error('fixture META is not a manifest');
  return manifest;
}

function store(): OxigraphStore {
  const created = new OxigraphStore();
  stores.push(created);
  return created;
}

/** Store an asset as durable sync does after chain authentication: data and confirmed metadata at once. */
async function storeConfirmed(target: OxigraphStore, fixture: AssetFixture): Promise<void> {
  const [verified] = partitionVerifiedGraphScopedAssets(CG, fixture.payload, fixture.meta, [fixture.graph]).assets;
  const metadataQuads = overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1(
    verified!.metadataQuads,
    { ual: verified!.ual, metaGraph: verified!.metaGraph, receivedAt: new Date(0) },
    {
      status: 'confirmed',
      materializedVersion: { blockNumber: 1, txIndex: 0 },
      confirmation: { kind: 'finalized-materialization' },
    },
  );
  expect(await materializeVerifiedGraphScopedAsset({ store: target, asset: { ...verified!, metadataQuads } }))
    .toBe('applied');
}

describe('which assets of a verified generation this node holds', () => {
  it('holds a confirmed copy at the same version and root, or at a newer version', async () => {
    const local = store();
    const same = asset(1);
    const newerHere = asset(2, { version: '2', value: 'v2' });
    const otherRoot = asset(3, { value: 'local' });
    const tentative = asset(4);
    await storeConfirmed(local, same);
    await storeConfirmed(local, newerHere);
    await storeConfirmed(local, otherRoot);
    await local.insert([...tentative.payload, ...tentative.meta]);

    const remote = manifestOf([same, asset(2), asset(3, { value: 'remote' }), tentative, asset(5)]);
    const held = await readHeldGraphScopedAssets(local, { contextGraphId: CG, descriptors: remote.descriptors }, 2);

    expect([...held].sort()).toEqual([same.ual, newerHere.ual].sort());
  });

  it('fails a store read that does not return complete bindings', async () => {
    const { descriptors } = manifestOf([asset(1)]);
    const answering = (answer: unknown) => ({ query: async () => answer }) as unknown as TripleStore;
    await expect(readHeldGraphScopedAssets(answering({ type: 'quads', quads: [] }), { contextGraphId: CG, descriptors }))
      .rejects.toThrow('expected a bindings result');
    await expect(readHeldGraphScopedAssets(
      answering({ type: 'bindings', bindings: [{ ual: descriptors[0]!.ual, predicate: 'urn:held:value' }] }),
      { contextGraphId: CG, descriptors },
    )).rejects.toThrow('incomplete binding');
  });

  it('does not hold an older confirmed copy', async () => {
    const local = store();
    await storeConfirmed(local, asset(1));
    const updated = manifestOf([asset(1, { version: '2', value: 'v2' })]);
    expect(await readHeldGraphScopedAssets(local, { contextGraphId: CG, descriptors: updated.descriptors }))
      .toEqual(new Set());
  });
});

describe('planning a DATA phase from holdings', () => {
  const generation = (count: number, rows = 3) => manifestOf(
    Array.from({ length: count }, (_, index) => asset(index + 1, { rows })),
  );
  const uals = (manifest: GraphScopedDurableManifestPlan) => manifest.descriptors.map((descriptor) => descriptor.ual);

  it('skips DATA when every asset is held', () => {
    const manifest = generation(4);
    expect(planDurableDataFromHoldings(manifest, new Set(uals(manifest)), true)).toEqual({ kind: 'held', assets: 4 });
  });

  it('leaves missing assets of a held generation to exact requests', () => {
    const manifest = generation(25);
    const missing = manifest.descriptors.slice(3, 15);
    const held = new Set(uals(manifest).filter((ual) => !missing.some((descriptor) => descriptor.ual === ual)));

    const plan = planDurableDataFromHoldings(manifest, held, true);

    expect(plan).toMatchObject({ kind: 'fetch-missing', held: 13, rows: 36 });
    // At most ten assets per request, in manifest order, with their versions.
    expect(plan.kind === 'fetch-missing' && plan.batches.map((batch) => batch.length)).toEqual([10, 2]);
    expect(plan.kind === 'fetch-missing' && plan.batches.flat()).toEqual(
      missing.map((descriptor) => ({ ual: descriptor.ual, assertionVersion: '1' })),
    );
  });

  it('keeps each exact request within one round of rows', () => {
    const manifest = generation(6, 5);
    const plan = planDurableDataFromHoldings(manifest, new Set([uals(manifest)[0]!]), true, {
      softRows: 12, softHeapBytes: 1_000, maxRows: 30, maxHeapBytes: 3_000,
    });
    expect(plan.kind === 'fetch-missing' && plan.batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it('pulls full-graph rounds for a first recovery, without an owner that fetches, or when cheaper', () => {
    // Six assets of five rows: 30 rows.
    const manifest = generation(6, 5);
    const budget = (softRows: number) => ({ softRows, softHeapBytes: 1_000, maxRows: 30, maxHeapBytes: 3_000 });
    const firstHeld = new Set(uals(manifest).slice(0, 1));
    expect(planDurableDataFromHoldings(manifest, new Set(), true)).toEqual({ kind: 'full', held: 0 });
    expect(planDurableDataFromHoldings(manifest, firstHeld, false)).toEqual({ kind: 'full', held: 1 });
    // Five single-asset requests: fewer than six full-graph rounds of 5 rows plus the held asset.
    expect(planDurableDataFromHoldings(manifest, firstHeld, true, budget(5)))
      .toMatchObject({ kind: 'fetch-missing', held: 1 });
    // Not fewer than four full-graph rounds of 8 rows plus the held asset.
    expect(planDurableDataFromHoldings(manifest, firstHeld, true, budget(8))).toEqual({ kind: 'full', held: 1 });
  });

  it('hands a fetch-missing plan to the owner and plans nothing when the store read fails', async () => {
    const manifest = generation(3);
    const channel: DurableHoldingsChannel = { ownerFetchesMissingAssets: true };
    const plan = await planDurableDataFromLocalHoldings({
      contextGraphId: CG,
      manifest,
      channel,
      readHeld: async () => new Set(uals(manifest).slice(1)),
      logWarn: () => {},
    });
    expect(plan?.kind).toBe('fetch-missing');
    expect(channel.missingAssetBatches).toEqual([[{ ual: uals(manifest)[0], assertionVersion: '1' }]]);
    expect(describeDurableHoldingsPlan(CG, manifest, plan as Exclude<typeof plan, undefined | { kind: 'full' }>))
      .toContain('2 of 3 assets already held; leaving 1 asset(s) (3 rows) to 1 exact request(s)');

    const logWarn = vi.fn();
    const failed = await planDurableDataFromLocalHoldings({
      contextGraphId: CG,
      manifest,
      channel: {},
      readHeld: async () => { throw new Error('store queue wait timeout'); },
      logWarn,
    });
    expect(failed).toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('store queue wait timeout'));

    const aborted = new AbortController();
    aborted.abort(new Error('node stopping'));
    await expect(planDurableDataFromLocalHoldings({
      contextGraphId: CG,
      manifest,
      channel: {},
      readHeld: async () => { throw new Error('aborted read'); },
      signal: aborted.signal,
      logWarn,
    })).rejects.toThrow('node stopping');
  });

  it('settles a held generation as a completed DATA phase at its terminal boundary', () => {
    const manifest = generation(3);
    const checkpoints = new MemorySyncCheckpointStore();
    const key = getSyncCheckpointKey('peer-held', CG, false, 'data');
    checkpoints.setManifestBoundOffset(key, 3, manifest.manifestDigest, Date.now(), undefined, false, 3);
    checkpoints.setResponderSession(key, 'stale-session', Date.now() + 60_000, Date.now(), manifest.manifestDigest);
    const accumulator = createDurableSyncAccumulator();

    settleHeldDurableData({
      remotePeerId: 'peer-held',
      contextGraphId: CG,
      manifest,
      accumulator,
      deleteCheckpoint: (checkpointKey) => checkpoints.delete(checkpointKey),
      setCheckpoint: (checkpointKey, checkpoint) => checkpoints.setManifestBoundOffset(
        checkpointKey,
        checkpoint.offset,
        checkpoint.binding!.manifestDigest,
        Date.now(),
        checkpoint.binding!.manifestPrefixDigest,
        checkpoint.binding!.terminal,
      ),
    });

    const settled = checkpoints.get(key);
    expect(settled).toMatchObject({
      offset: manifest.manifestRowCount,
      manifestDigest: manifest.manifestDigest,
      manifestPrefixDigest: graphScopedDurableManifestPrefixAtOffset(manifest, manifest.manifestRowCount)!.prefixDigest,
      terminal: true,
    });
    expect(settled?.responderSessionId).toBeUndefined();
    expect(finalizeDurableSyncCompletion(accumulator)).toMatchObject({ resumedPhases: 1, completedPhases: 1 });
  });
});
