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
  currentHeldGraphScopedAssetsReader,
  HeldGenerationNotCurrentError,
  readHeldGraphScopedAssets,
  settleDurableDataFromHoldings,
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
function asset(
  kaNumber: number,
  options: { version?: string; rows?: number; value?: string; privateOnly?: boolean } = {},
): AssetFixture {
  const version = options.version ?? '1';
  const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ef/${kaNumber}`;
  const graph = knowledgeAssetLayerGraphUri(
    CG,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(ual, version),
  );
  const privateRoot = options.privateOnly ? new Uint8Array(32).fill(0x66) : undefined;
  const payload = Array.from({ length: options.privateOnly ? 0 : options.rows ?? 3 }, (_, index): Quad => ({
    subject: `urn:held:${kaNumber}:${index}`,
    predicate: 'urn:held:value',
    object: `"${options.value ?? 'v1'}-${index}"`,
    graph,
  }));
  const meta = generateGraphKnowledgeAssetMetadata({
    ual,
    contextGraphId: CG,
    merkleRoot: computeFlatKCRootV10(payload, privateRoot ? [privateRoot] : []),
    publisherPeerId: 'publisher-peer',
    accessPolicy: 'public',
    timestamp: new Date(0),
    assertionVersion: version,
    publicTripleCount: payload.length,
    privateTripleCount: privateRoot ? 1 : 0,
    ...(privateRoot ? { privateMerkleRoot: privateRoot } : {}),
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
  it('holds a confirmed copy of the same version and root whose rows are all stored', async () => {
    const local = store();
    const same = asset(1);
    const newerHere = asset(2, { version: '2', value: 'v2' });
    const otherRoot = asset(3, { value: 'local' });
    const tentative = asset(4);
    const privateOnly = asset(6, { privateOnly: true });
    await storeConfirmed(local, same);
    await storeConfirmed(local, newerHere);
    await storeConfirmed(local, otherRoot);
    await storeConfirmed(local, privateOnly);
    await local.insert([...tentative.payload, ...tentative.meta]);

    const remote = manifestOf([same, asset(2), asset(3, { value: 'remote' }), tentative, asset(5), privateOnly]);
    const held = await readHeldGraphScopedAssets(local, { contextGraphId: CG, descriptors: remote.descriptors }, 2);

    // A newer local version is not this peer's generation; a zero-public asset holds with no rows.
    expect([...held].sort()).toEqual([same.ual, privateOnly.ual].sort());
  });

  it('does not hold a confirmed copy whose rows were removed', async () => {
    const local = store();
    const dropped = asset(1);
    const thinned = asset(2);
    const kept = asset(3);
    for (const fixture of [dropped, thinned, kept]) await storeConfirmed(local, fixture);
    // A removed sub-graph drops the rows and keeps the confirmed envelope.
    await local.dropGraph(dropped.graph);
    await local.deleteByPattern({ ...thinned.payload[0]! });

    const { descriptors } = manifestOf([dropped, thinned, kept]);
    expect(await readHeldGraphScopedAssets(local, { contextGraphId: CG, descriptors })).toEqual(new Set([kept.ual]));
  });

  it('fails a row count that does not return bindings', async () => {
    const local = store();
    await storeConfirmed(local, asset(1));
    const counting = {
      query: (sparql: string, options?: object) => (sparql.includes('COUNT(*)')
        ? Promise.resolve({ type: 'quads', quads: [] })
        : local.query(sparql, options)),
    } as unknown as TripleStore;
    await expect(readHeldGraphScopedAssets(counting, { contextGraphId: CG, descriptors: manifestOf([asset(1)]).descriptors }))
      .rejects.toThrow('Held asset row COUNT expected a bindings result');
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

    // A held copy the chain does not confirm fails the round instead of falling back to a full pull.
    await expect(planDurableDataFromLocalHoldings({
      contextGraphId: CG,
      manifest,
      channel: {},
      readHeld: async () => { throw new HeldGenerationNotCurrentError('behind the chain'); },
      logWarn,
    })).rejects.toBeInstanceOf(HeldGenerationNotCurrentError);
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
    expect(finalizeDurableSyncCompletion(accumulator))
      .toMatchObject({ resumedPhases: 1, completedPhases: 1, verifiedHeldAssets: 3 });
  });

  it('completes a held round and leaves a fetch-missing round to the owner', () => {
    const manifest = generation(3);
    const checkpoints = new MemorySyncCheckpointStore();
    const settle = (plan: Parameters<typeof settleDurableDataFromHoldings>[0]['plan']) => {
      const accumulator = createDurableSyncAccumulator();
      const line = settleDurableDataFromHoldings({
        plan,
        remotePeerId: 'peer-settle',
        contextGraphId: CG,
        manifest,
        metaResult: { bytesReceived: 512, quads: manifest.descriptors.map(() => ({}) as Quad) },
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
      return { line, result: finalizeDurableSyncCompletion(accumulator) };
    };
    const key = getSyncCheckpointKey('peer-settle', CG, false, 'data');

    const missing = settle({ kind: 'fetch-missing', held: 2, batches: [[{ ual: uals(manifest)[0]!, assertionVersion: '1' }]], rows: 3 });
    expect(missing.result).toMatchObject({
      complete: false, bytesReceived: 512, fetchedMetaTriples: 3, fetchedDataTriples: 0, verifiedHeldAssets: 0,
    });
    expect(checkpoints.get(key)).toBeUndefined();
    expect(missing.line).toContain('leaving 1 asset(s)');

    const held = settle({ kind: 'held', assets: 3 });
    expect(held.result).toMatchObject({
      complete: true, resumedPhases: 1, completedPhases: 1, fetchedDataTriples: 0, verifiedHeldAssets: 3,
    });
    expect(checkpoints.get(key)).toMatchObject({ offset: manifest.manifestRowCount, terminal: true });
    expect(held.line).toContain('skipping the DATA phase');
  });
});

describe('holding a copy only while it is current on chain', () => {
  type ChainState = { merkleRootHex: string; assertionVersion: bigint; bound: boolean };
  const generation = () => manifestOf([asset(1), asset(2), asset(3)]);
  const currentOf = (manifest: GraphScopedDurableManifestPlan) => new Map<string, ChainState>(
    manifest.descriptors.map((descriptor) => [descriptor.ual, {
      merkleRootHex: descriptor.claimedRootHex,
      assertionVersion: BigInt(descriptor.assertionVersion),
      bound: true,
    }]),
  );
  function reader(chain: Map<string, ChainState>, held: readonly string[], reads: string[] = [], deadlines: number[] = []) {
    return currentHeldGraphScopedAssetsReader({
      readHeld: async () => new Set(held),
      readChainState: async ({ ual }, deadline) => {
        reads.push(ual);
        deadlines.push(deadline);
        const state = chain.get(ual);
        if (!state) throw new Error('chain endpoint unavailable');
        return state;
      },
      budget: { createGraphScopedAuthenticationDeadline: () => 42 },
    })!;
  }

  it('keeps held copies the chain confirms, and reads only those', async () => {
    const manifest = generation();
    const held = [manifest.descriptors[0]!.ual, manifest.descriptors[2]!.ual];
    const reads: string[] = [];
    const deadlines: number[] = [];

    expect(await reader(currentOf(manifest), held, reads, deadlines)({ contextGraphId: CG, descriptors: manifest.descriptors }))
      .toEqual(new Set(held));
    expect(reads.sort()).toEqual([...held].sort());
    expect(deadlines).toEqual([42, 42]);
  });

  it('fails a peer generation whose held copy is behind the chain', async () => {
    const manifest = generation();
    const chain = currentOf(manifest);
    const behind = manifest.descriptors[1]!;
    const all = manifest.descriptors.map((descriptor) => descriptor.ual);
    chain.set(behind.ual, { merkleRootHex: 'ab'.repeat(32), assertionVersion: 2n, bound: true });

    await expect(reader(chain, all)({ contextGraphId: CG, descriptors: manifest.descriptors }))
      .rejects.toThrow(`${behind.ual} is at version 2 on chain, 1 here and at the peer`);
    // The same version with another root is not current either.
    chain.set(behind.ual, { merkleRootHex: 'ab'.repeat(32), assertionVersion: 1n, bound: true });
    await expect(reader(chain, all)({ contextGraphId: CG, descriptors: manifest.descriptors }))
      .rejects.toBeInstanceOf(HeldGenerationNotCurrentError);
  });

  it('fails an asset bound elsewhere, and a chain that cannot answer', async () => {
    const manifest = generation();
    const first = manifest.descriptors[0]!;
    const unbound = currentOf(manifest);
    unbound.set(first.ual, { ...unbound.get(first.ual)!, bound: false });
    await expect(reader(unbound, [first.ual])({ contextGraphId: CG, descriptors: manifest.descriptors }))
      .rejects.toThrow(`Held asset ${first.ual} is not bound to "${CG}" on chain`);

    const unreachable = reader(new Map(), [first.ual])({ contextGraphId: CG, descriptors: manifest.descriptors });
    await expect(unreachable).rejects.toBeInstanceOf(HeldGenerationNotCurrentError);
    await expect(unreachable).rejects.toThrow('chain endpoint unavailable');
  });

  it('stops at an abort, and plans no shortcut without a store or a chain', async () => {
    const manifest = generation();
    const aborted = new AbortController();
    aborted.abort(new Error('node stopping'));
    await expect(reader(new Map(), [manifest.descriptors[0]!.ual])({
      contextGraphId: CG,
      descriptors: manifest.descriptors,
      signal: aborted.signal,
    })).rejects.toThrow('node stopping');

    const budget = { createGraphScopedAuthenticationDeadline: () => 42 };
    expect(currentHeldGraphScopedAssetsReader({ readHeld: async () => new Set<string>(), budget })).toBeUndefined();
    expect(currentHeldGraphScopedAssetsReader({ readChainState: async () => ({ merkleRootHex: '', assertionVersion: 1n, bound: true }), budget }))
      .toBeUndefined();
  });
});
