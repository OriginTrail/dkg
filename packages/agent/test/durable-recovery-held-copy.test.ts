import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type QueryOptions, type TripleStore } from '@origintrail-official/dkg-storage';
import { RecoveryMaterializationOwner, type RecoveryMaterializationPorts } from '../src/durable-recovery-materialization.js';
import type { DurableRecoveryAuthority } from '../src/durable-recovery-authority.js';
import * as materialization from '../src/sync/requester/graph-scoped-materialization.js';
import { materializeVerifiedGraphScopedAsset, type VerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { materializedAssetConsumer } from '../src/sync/requester/durable-asset-consumer.js';
import { createDurableSyncAccumulator } from '../src/sync/durable-progress.js';

afterEach(() => vi.restoreAllMocks());

const DKG = 'http://dkg.io/ontology/';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const contextGraphId = 'held-copy-recovery';
const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
const assertionGraph = `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/0x1111111111111111111111111111111111111111/1`;
const ual = 'did:dkg:otp:2043/0x1111111111111111111111111111111111111111/1';
const root = 'ab'.repeat(32);

function dataQuads(version: number, rows = 3): Quad[] {
  return Array.from({ length: rows }, (_, index) => ({
    subject: `http://example.com/entity/${index}`,
    predicate: 'http://example.com/value',
    object: `"v${version}-${index}"`,
    graph: assertionGraph,
  }));
}

function asset(version = 1, receivedAt = '2026-11-19T08:00:00.000Z'): VerifiedGraphScopedAsset {
  return {
    merkleRootHex: root,
    contextGraphId,
    ual,
    assertionVersion: BigInt(version),
    assertionGraph,
    metaGraph,
    dataQuads: dataQuads(version),
    metadataQuads: [
      ['assertionVersion', `"${version}"`],
      ['assertionGraph', assertionGraph],
      ['merkleRoot', `"${root}"`],
      ['status', '"confirmed"'],
      ['publishedAt', `"${receivedAt}"^^<${XSD_DATE_TIME}>`],
    ].map(([predicate, object]) => ({ subject: ual, predicate: `${DKG}${predicate}`, object, graph: metaGraph })),
  };
}

async function rows(store: TripleStore, graph: string, subject?: string): Promise<string[]> {
  const result = await store.query(subject
    ? `SELECT ?p ?o WHERE { GRAPH <${graph}> { <${subject}> ?p ?o } }`
    : `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  if (result.type !== 'bindings') return [];
  return result.bindings.map(row => [row.s, row.p, row.o].filter(Boolean).join(' ')).sort();
}

/** A held copy as the first recovery leaves it, and a count of the replacements written after it. */
async function heldCopy(store = new OxigraphStore()) {
  await expect(materializeVerifiedGraphScopedAsset({ store, asset: asset() })).resolves.toBe('applied');
  const writes = vi.spyOn(store, 'replaceGraphAndSubject');
  return { store, writes };
}

describe('recovering a graph-scoped copy this node already holds', () => {
  it('does not write a same-version replay the store already holds exactly', async () => {
    const { store, writes } = await heldCopy();
    const before = { data: await rows(store, assertionGraph), meta: await rows(store, metaGraph, ual) };

    await expect(materializeVerifiedGraphScopedAsset({ store, asset: asset(), keepHeldCopy: true }))
      .resolves.toBe('unchanged');

    expect(writes).not.toHaveBeenCalled();
    expect({ data: await rows(store, assertionGraph), meta: await rows(store, metaGraph, ual) }).toEqual(before);
  });

  it('keeps the first receive time when only this replay was received later', async () => {
    const { store, writes } = await heldCopy();

    await expect(materializeVerifiedGraphScopedAsset({
      store, asset: asset(1, '2026-11-19T09:30:00.000Z'), keepHeldCopy: true,
    })).resolves.toBe('unchanged');

    expect(writes).not.toHaveBeenCalled();
    expect(await rows(store, metaGraph, ual)).toContain(`${DKG}publishedAt "2026-11-19T08:00:00Z"^^<${XSD_DATE_TIME}>`);
  });

  it('replaces a held copy that has an extra row', async () => {
    const { store, writes } = await heldCopy();
    await store.insert([{ subject: 'http://example.com/injected', predicate: 'http://example.com/value',
      object: '"extra"', graph: assertionGraph }]);

    await expect(materializeVerifiedGraphScopedAsset({ store, asset: asset(), keepHeldCopy: true }))
      .resolves.toBe('applied');

    expect(writes).toHaveBeenCalledOnce();
    expect(await rows(store, assertionGraph)).not.toContain('http://example.com/injected http://example.com/value "extra"');
    expect(await rows(store, assertionGraph)).toHaveLength(3);
  });

  it('replaces a held copy that lacks a row', async () => {
    const { store, writes } = await heldCopy();
    await store.delete([dataQuads(1)[0]!]);

    await expect(materializeVerifiedGraphScopedAsset({ store, asset: asset(), keepHeldCopy: true }))
      .resolves.toBe('applied');

    expect(writes).toHaveBeenCalledOnce();
    expect(await rows(store, assertionGraph)).toHaveLength(3);
  });

  it('replaces a held copy whose metadata differs from the replacement', async () => {
    const { store, writes } = await heldCopy();
    await store.insert([{ subject: ual, predicate: `${DKG}publicTripleCount`, object: '"99"', graph: metaGraph }]);

    await expect(materializeVerifiedGraphScopedAsset({ store, asset: asset(), keepHeldCopy: true }))
      .resolves.toBe('applied');

    expect(writes).toHaveBeenCalledOnce();
    expect(await rows(store, metaGraph, ual)).not.toContain(`${DKG}publicTripleCount "99"`);
  });

  it('still writes and quarantines a held copy whose binding changed during the replay', async () => {
    const { store, writes } = await heldCopy();

    await expect(materializeVerifiedGraphScopedAsset({
      store, asset: asset(), keepHeldCopy: true, shouldQuarantineCommitted: () => true,
    })).resolves.toBe('quarantined');

    expect(writes).toHaveBeenCalledTimes(2);
    expect(await rows(store, assertionGraph)).toEqual([]);
    expect(await rows(store, metaGraph, ual)).toEqual([]);
  });

  it('writes a same-version replay as before when the caller does not keep held copies', async () => {
    const { store, writes } = await heldCopy();

    await expect(materializeVerifiedGraphScopedAsset({ store, asset: asset() })).resolves.toBe('applied');

    expect(writes).toHaveBeenCalledOnce();
  });

  it('still refuses a replay older than the stored version', async () => {
    const store = new OxigraphStore();
    await expect(materializeVerifiedGraphScopedAsset({ store, asset: asset(2) })).resolves.toBe('applied');

    await expect(materializeVerifiedGraphScopedAsset({ store, asset: asset(1), keepHeldCopy: true }))
      .resolves.toBe('stale');
  });

  it('writes a newer version over a held older one', async () => {
    const { store, writes } = await heldCopy();

    await expect(materializeVerifiedGraphScopedAsset({ store, asset: asset(2), keepHeldCopy: true }))
      .resolves.toBe('applied');

    expect(writes).toHaveBeenCalledOnce();
    expect(await rows(store, assertionGraph)).toContain('http://example.com/entity/0 http://example.com/value "v2-0"');
  });

  it('writes, as before, when the store refuses the held-copy read', async () => {
    const { store, writes } = await heldCopy();
    const query = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (sparql: string, options?: QueryOptions) => {
      if (options?.source?.endsWith('.heldCopy')) throw new Error('store busy');
      return query(sparql, options);
    });

    await expect(materializeVerifiedGraphScopedAsset({
      store, asset: asset(), keepHeldCopy: true, options: { source: 'agent.durableSync.graphScopedMaterialization' },
    })).resolves.toBe('applied');

    expect(writes).toHaveBeenCalledOnce();
  });

  it('stops without writing when the operation is cancelled during the held-copy read', async () => {
    const { store, writes } = await heldCopy();
    const controller = new AbortController();
    const query = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (sparql: string, options?: QueryOptions) => {
      if (options?.source?.endsWith('.heldCopy')) {
        controller.abort(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      }
      return query(sparql, options);
    });

    await expect(materializeVerifiedGraphScopedAsset({
      store, asset: asset(), keepHeldCopy: true, options: { signal: controller.signal },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(writes).not.toHaveBeenCalled();
  });
});

describe('counting an unchanged recovery write', () => {
  it('counts it as a held asset and as committed for an exact request, not as inserted data', async () => {
    const accumulator = createDurableSyncAccumulator();
    const committed: string[] = [];
    const consume = materializedAssetConsumer({
      context: { ctx: createOperationContext('sync'), logDebug: () => {}, logWarn: () => {} },
      materialize: async () => 'unchanged',
      accumulator,
      committedExactAssetUals: committed,
    });

    await consume(asset(), Date.now() + 1_000);

    expect(committed).toEqual([ual]);
    expect(accumulator.diagnosticsSnapshot()).toMatchObject({
      verifiedHeldAssets: 1, insertedTriples: 0, insertedDataTriples: 0, insertedMetaTriples: 0,
    });
  });

  it('keeps held copies in recovery and gives them the twin housekeeping a written copy gets', async () => {
    const recovered = asset();
    const reconcile = vi.fn(async () => {});
    const timings: string[] = [];
    const subscription = { onChainId: '1' };
    const ports = {
      store: () => ({}),
      isClosed: () => false,
      subscription: () => subscription,
      bindingGeneration: () => 0,
      isBindingGenerationCurrent: () => true,
      track: () => {},
      recordDrops: () => {},
      logTiming: (_ctx: unknown, message: string) => { timings.push(message); },
      reconcile,
    } as unknown as RecoveryMaterializationPorts;
    const authority = {
      coalescing: 'owner-only', admitVerifiedPage() {}, isRegisteredPublic: () => true,
      authenticate: async () => ({ asset: recovered, onChainContextGraphId: '1' }),
    } as unknown as DurableRecoveryAuthority;
    const materialize = vi.spyOn(materialization, 'materializeVerifiedGraphScopedAsset')
      .mockImplementation(async () => 'unchanged');
    const scope = new RecoveryMaterializationOwner(ports).forOperation({
      ctx: createOperationContext('sync'), contextGraphId, authority,
    });

    await expect(scope.storeGraphScopedAsset({ asset: recovered, authenticationDeadline: Date.now() + 2_000 }))
      .resolves.toBe('unchanged');

    expect(materialize.mock.calls[0]![0]).toMatchObject({ keepHeldCopy: true });
    expect(reconcile).toHaveBeenCalledWith(recovered, expect.anything());
    expect(timings.at(-1)).toMatch(/outcome=unchanged$/);
  });
});
