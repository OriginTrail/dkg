import { createListContextGraphsCacheInvalidatingStore } from '../src/internal/context-graph-cache-invalidating-store.js';
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
import { createRpcTimeoutError } from '@origintrail-official/dkg-chain';
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
  currentHeldGraphScopedAssetsConfirmer,
  HELD_CHAIN_CHECK_BUDGET_MS,
  HeldGenerationNotCurrentError,
  readHeldGraphScopedAssets,
  settleDurableDataFromHoldings,
  settleHeldDurableData,
  type DurableHoldingsOptions,
  type ConfirmHeldAssetsCurrent,
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

  it.each([false, true])('rejects a same-count edit before recovery, recreated owner=%s', async recreate => {
    const raw = store();
    const fixture = asset(1, { rows: 1 });
    await storeConfirmed(raw, fixture);
    const owner = createListContextGraphsCacheInvalidatingStore(raw, () => {});
    await owner.delete(fixture.payload);
    await owner.insert([{ ...fixture.payload[0]!, object: '"tampered"' }]);
    const reader = recreate ? createListContextGraphsCacheInvalidatingStore(raw, () => {}) : owner;
    expect(await reader.countQuads(fixture.graph)).toBe(1);
    expect(await readHeldGraphScopedAssets(reader, { contextGraphId: CG, descriptors: manifestOf([fixture]).descriptors }))
      .toEqual(new Set());
  });

  it('keeps exact content verification in the cancellable background lane', async () => {
    const local = store();
    const fixture = asset(1);
    await storeConfirmed(local, fixture);
    const query = vi.spyOn(local, 'query');
    const signal = new AbortController().signal;
    expect(await readHeldGraphScopedAssets(local, {
      contextGraphId: CG, descriptors: manifestOf([fixture]).descriptors, signal,
    })).toEqual(new Set([fixture.ual]));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT ?s ?p ?o'), expect.objectContaining({
      source: 'agent.durableSync.heldAssetContent', priority: 'background', signal,
    }));
  });

  it('fails an assertion read that does not return bindings', async () => {
    const local = store();
    await storeConfirmed(local, asset(1));
    const counting = {
      query: (sparql: string, options?: object) => (sparql.includes('SELECT ?s ?p ?o')
        ? Promise.resolve({ type: 'quads', quads: [] })
        : local.query(sparql, options)),
    } as unknown as TripleStore;
    await expect(readHeldGraphScopedAssets(counting, { contextGraphId: CG, descriptors: manifestOf([asset(1)]).descriptors }))
      .rejects.toThrow('Exact graph read expected SELECT bindings');
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

  it('hands a fetch-missing plan to the owner and reconsiders holdings after a chain timeout', async () => {
    const manifest = generation(3);
    const channel: DurableHoldingsOptions = { ownerFetchesMissingAssets: true };
    const outcome = await planDurableDataFromLocalHoldings({
      contextGraphId: CG,
      manifest,
      options: channel,
      held: new Set(uals(manifest).slice(1)), confirmCurrent: async () => {},
      logWarn: () => {},
    });
    const plan = outcome;
    expect(plan?.kind).toBe('fetch-missing');
    expect(plan?.kind === 'fetch-missing' ? plan.batches : undefined).toEqual([[{ ual: uals(manifest)[0], assertionVersion: '1' }]]);
    expect(describeDurableHoldingsPlan(CG, manifest, plan as Exclude<typeof plan, undefined | { kind: 'full' }>))
      .toContain('2 of 3 assets already held; leaving 1 asset(s) (3 rows) to 1 exact request(s)');

    const logWarn = vi.fn();
    const failed = await planDurableDataFromLocalHoldings({
      contextGraphId: CG,
      manifest,
      options: {},
      held: new Set(uals(manifest)), confirmCurrent: async () => { throw new Error('chain timeout'); },
      logWarn,
    });
    expect(failed).toEqual({ kind: 'full', held: 0, continuation: 'reconsider-holdings' });
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('chain timeout'));

    const aborted = new AbortController();
    aborted.abort(new Error('node stopping'));
    await expect(planDurableDataFromLocalHoldings({
      contextGraphId: CG,
      manifest,
      options: {},
      held: new Set(uals(manifest)), confirmCurrent: async () => {},
      signal: aborted.signal,
      logWarn,
    })).rejects.toThrow('node stopping');

    // A held copy the chain shows superseded fails the round instead of falling back to a full pull.
    await expect(planDurableDataFromLocalHoldings({
      contextGraphId: CG,
      manifest,
      options: {},
      held: new Set(uals(manifest)),
      confirmCurrent: async () => { throw new HeldGenerationNotCurrentError('behind the chain'); },
      logWarn,
    })).rejects.toBeInstanceOf(HeldGenerationNotCurrentError);
  });

  it('asks the chain only when the plan skips held copies', async () => {
    const manifest = generation(3);
    const confirmCurrent = vi.fn(async () => {});
    const plan = (held: readonly string[], ownerFetchesMissingAssets: boolean) => planDurableDataFromLocalHoldings({
      contextGraphId: CG,
      manifest,
      options: { ownerFetchesMissingAssets },
      held: new Set(held), confirmCurrent,
      logWarn: () => {},
    });

    // Full-graph rounds authenticate everything they fetch, as a first recovery's rounds do.
    expect(await plan(uals(manifest).slice(1), false)).toMatchObject({ kind: 'full' });
    expect(await plan([], true)).toMatchObject({ kind: 'full' });
    expect(confirmCurrent).not.toHaveBeenCalled();
    expect(await plan(uals(manifest).slice(1), true)).toMatchObject({ kind: 'fetch-missing' });
    expect(await plan(uals(manifest), true)).toMatchObject({ kind: 'held' });
    expect(confirmCurrent).toHaveBeenCalledTimes(2);
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
      complete: false, bytesReceived: 0, fetchedMetaTriples: 0, fetchedDataTriples: 0, verifiedHeldAssets: 0,
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
  type ChainState = { onChainContextGraphId: string; merkleRootHex: string; assertionVersion: bigint; bound: boolean };
  const generation = (count = 3) => manifestOf(Array.from({ length: count }, (_, index) => asset(index + 1)));
  const currentOf = (manifest: GraphScopedDurableManifestPlan) => new Map<string, ChainState>(
    manifest.descriptors.map((descriptor) => [descriptor.ual, {
      merkleRootHex: descriptor.claimedRootHex,
      assertionVersion: BigInt(descriptor.assertionVersion),
      bound: true, onChainContextGraphId: '9',
    }]),
  );
  function reader(
    chain: Map<string, ChainState>,
    reads: string[] = [],
    deadlines: number[] = [],
    authenticationDeadline = () => 42,
  ) {
    return currentHeldGraphScopedAssetsConfirmer({
      authenticateHeld: async (descriptor, requiredBinding, deadline) => {
        const { ual } = descriptor;
        reads.push(ual);
        deadlines.push(deadline);
        const state = chain.get(ual);
        if (!state) throw createRpcTimeoutError('held chain check exceeded its context-graph deadline');
        const matches = state.bound && (requiredBinding === undefined || state.onChainContextGraphId === requiredBinding)
          && state.merkleRootHex === descriptor.claimedRootHex && state.assertionVersion === BigInt(descriptor.assertionVersion);
        return matches ? { kind: 'match' } : { kind: 'mismatch', code: 'VM_CHAIN_ROOT_MISMATCH', message: `Held asset ${ual} is not current on chain` };
      },
      budget: { createGraphScopedAuthenticationDeadline: authenticationDeadline },
    })!;
  }
  const confirm = (holdings: ConfirmHeldAssetsCurrent, manifest: GraphScopedDurableManifestPlan, held: readonly string[],
    signal?: AbortSignal) => holdings({ contextGraphId: CG, descriptors: manifest.descriptors, signal }, new Set(held));

  it('rechecks a cached held copy when the numeric subscription binding changes', async () => {
    const manifest = generation(1);
    const descriptor = manifest.descriptors[0]!;
    let onChainId = '323';
    const authenticateHeld = vi.fn(async (_descriptor, requiredBinding) => requiredBinding === '323' ? { kind: 'match' as const } : { kind: 'mismatch' as const, code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH' as const, message: 'binding mismatch' });
    const holdings = currentHeldGraphScopedAssetsConfirmer({
      authenticateHeld,
      binding: () => ({ onChainId, generation: 0 }),
      budget: { createGraphScopedAuthenticationDeadline: () => Date.now() + 1000 },
    })!;
    const confirmed = new Set<string>();
    const request = { contextGraphId: CG, descriptors: manifest.descriptors };
    await holdings(request, new Set([descriptor.ual]), confirmed);
    await holdings(request, new Set([descriptor.ual]), confirmed);
    expect(authenticateHeld).toHaveBeenCalledTimes(1);
    onChainId = '582';
    await expect(holdings(request, new Set([descriptor.ual]), confirmed)).rejects.toBeInstanceOf(HeldGenerationNotCurrentError);
    expect(authenticateHeld).toHaveBeenCalledTimes(2);
  });

  it('confirms held copies the chain shows current, and reads only those', async () => {
    const manifest = generation();
    const held = [manifest.descriptors[0]!.ual, manifest.descriptors[2]!.ual];
    const reads: string[] = [];
    const deadlines: number[] = [];

    await expect(confirm(reader(currentOf(manifest), reads, deadlines), manifest, held)).resolves.toBeUndefined();
    expect(reads.sort()).toEqual([...held].sort());
    expect(deadlines).toEqual([42, 42]);
  });

  it('bounds the checks by one budget, even with a later authentication deadline', async () => {
    const manifest = generation();
    const deadlines: number[] = [];
    const startedAt = Date.now();
    await confirm(reader(currentOf(manifest), [], deadlines, () => startedAt + 3_600_000), manifest,
      [manifest.descriptors[0]!.ual]);
    expect(deadlines[0]).toBeGreaterThanOrEqual(startedAt + HELD_CHAIN_CHECK_BUDGET_MS);
    expect(deadlines[0]).toBeLessThanOrEqual(Date.now() + HELD_CHAIN_CHECK_BUDGET_MS);
  });

  it('fails a peer generation whose held copy is behind the chain', async () => {
    const manifest = generation();
    const chain = currentOf(manifest);
    const behind = manifest.descriptors[1]!;
    const all = manifest.descriptors.map((descriptor) => descriptor.ual);
    chain.set(behind.ual, { merkleRootHex: 'ab'.repeat(32), assertionVersion: 2n, bound: true });

    await expect(confirm(reader(chain), manifest, all))
      .rejects.toThrow(`Held asset ${behind.ual} of "${CG}" is not current on chain`);
    // The same version with another root is not current either.
    chain.set(behind.ual, { merkleRootHex: 'ab'.repeat(32), assertionVersion: 1n, bound: true });
    await expect(confirm(reader(chain), manifest, all)).rejects.toBeInstanceOf(HeldGenerationNotCurrentError);
  });

  it('fails an asset bound elsewhere; a chain that cannot answer is not a verdict', async () => {
    const manifest = generation();
    const first = manifest.descriptors[0]!;
    const unbound = currentOf(manifest);
    unbound.set(first.ual, { ...unbound.get(first.ual)!, bound: false });
    await expect(confirm(reader(unbound), manifest, [first.ual]))
      .rejects.toThrow(`Held asset ${first.ual} of "${CG}" is not current on chain`);

    const unanswered = confirm(reader(new Map()), manifest, [first.ual]);
    await expect(unanswered).rejects.toThrow("against the chain within the round's budget");
    await expect(unanswered).rejects.not.toBeInstanceOf(HeldGenerationNotCurrentError);
  });

  it('falls back to DATA rounds when a large graph cannot be confirmed within the budget', async () => {
    // Hundreds of held assets, and a chain whose answers stop when the round's budget runs out.
    const manifest = generation(300);
    const answered = new Map([...currentOf(manifest)].slice(0, 100));
    const holdings = reader(answered);
    const channel: DurableHoldingsOptions = { ownerFetchesMissingAssets: true };
    const logWarn = vi.fn();

    const plan = await planDurableDataFromLocalHoldings({
      contextGraphId: CG,
      manifest,
      options: channel,
      held: new Set(manifest.descriptors.map((descriptor) => descriptor.ual)), confirmCurrent: holdings,
      logWarn,
    });

    // No shortcut this round, and no failure: the round pulls the graph in bounded rounds.
    expect(plan).toMatchObject({ kind: 'full', continuation: 'reconsider-holdings' });
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("against the chain within the round's budget"));
  });

  it('leaves a later round of the run only the copies an earlier round did not confirm', async () => {
    const manifest = generation(300);
    const all = manifest.descriptors.map((descriptor) => descriptor.ual);
    const confirmed = new Set<string>();
    const confirmOnce = (chain: Map<string, ChainState>, reads: string[]) => reader(chain, reads)({ contextGraphId: CG, descriptors: manifest.descriptors }, new Set(all), confirmed);

    // The first round's budget ends after a third of the checks; the ones it finished stay confirmed.
    await expect(confirmOnce(new Map([...currentOf(manifest)].slice(0, 100)), []))
      .rejects.toThrow("within the round's budget");
    expect(confirmed.size).toBe(100);

    const reads: string[] = [];
    await confirmOnce(currentOf(manifest), reads);
    expect(reads.sort()).toEqual(all.slice(100).sort());
    expect(confirmed.size).toBe(300);
  });

  it('stops at an abort, and offers no confirmation without a chain', async () => {
    const manifest = generation();
    const aborted = new AbortController();
    aborted.abort(new Error('node stopping'));
    await expect(confirm(reader(new Map()), manifest, [manifest.descriptors[0]!.ual], aborted.signal))
      .rejects.toThrow('node stopping');

    const budget = { createGraphScopedAuthenticationDeadline: () => 42 };
    expect(currentHeldGraphScopedAssetsConfirmer({ budget })).toBeUndefined();
  });
});
