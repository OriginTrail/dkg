import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { activeRpcRequestContext } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphCatalogUri,
  contextGraphDataUri, contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import {
  prepareUnscopedContextGraphReadChecks,
  type UnscopedContextGraphReadCheckDependencies,
} from '../src/prepare-unscoped-context-graph-read-checks.js';

const commitment = (id: string) => ethers.keccak256(ethers.toUtf8Bytes(id));

function dependencies() {
  return {
    canReadContextGraph: vi.fn<UnscopedContextGraphReadCheckDependencies['canReadContextGraph']>(async () => false),
    contextGraphNameCommitment: vi.fn(commitment),
    requiresIndividualRead: vi.fn<UnscopedContextGraphReadCheckDependencies['requiresIndividualRead']>(() => false),
    findContextGraphIdsWithReadAuthorityFacts: vi.fn<UnscopedContextGraphReadCheckDependencies['findContextGraphIdsWithReadAuthorityFacts']>(async () => new Set<string>()),
    readMetadataRevision: vi.fn(() => 0),
    resolveContextGraphIdsByNameHashes: vi.fn<NonNullable<UnscopedContextGraphReadCheckDependencies['resolveContextGraphIdsByNameHashes']>>(
      async (names) => new Map(names.map((name) => [name, null])),
    ),
  } satisfies UnscopedContextGraphReadCheckDependencies;
}

describe('prepared unscoped Context Graph read checks', () => {
  it('uses a complete bulk proof for more than 512 ordinary KA interpretations', async () => {
    const ids = Array.from({ length: 650 }, (_, i) => `public/_verifiable_memory/author/${i}`);
    const deps = dependencies();
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ids, signal);
    expect(await Promise.all(ids.map((id) => check(id, signal)))).toEqual(ids.map(() => true));
    expect(deps.resolveContextGraphIdsByNameHashes).toHaveBeenCalledTimes(1);
    expect(deps.resolveContextGraphIdsByNameHashes.mock.calls[0][0]).toHaveLength(650);
    expect(deps.canReadContextGraph).not.toHaveBeenCalled();
  });

  it('keeps known/numeric/current-binding/wire aliases and live private selections on full authority', async () => {
    const individual = new Set(['known', '42', 'current-binding', 'wire-alias', 'live-private']);
    const deps = dependencies();
    deps.requiresIndividualRead.mockImplementation((id: string) => individual.has(id));
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, [...individual, 'ordinary'], signal);
    for (const id of individual) expect(await check(id, signal)).toBe(false);
    expect(await check('ordinary', signal)).toBe(true);
    expect(await check('not-in-prepared-request', signal)).toBe(false);
    expect(deps.resolveContextGraphIdsByNameHashes.mock.calls[0][0]).toEqual([commitment('ordinary')]);
    expect(deps.canReadContextGraph).toHaveBeenCalledTimes(individual.size + 1);
  });

  it('retains positive registration and metadata-only private gates beyond the previous cutoff', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `public/partition/${i}`);
    const registered = ids[599];
    const privateGate = ids[598];
    const deps = dependencies();
    deps.resolveContextGraphIdsByNameHashes.mockImplementation(async (names) => (
      new Map(names.map((name) => [name, name === commitment(registered) ? 9n : null]))
    ));
    deps.findContextGraphIdsWithReadAuthorityFacts.mockResolvedValue(new Set([privateGate]));
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ids, signal);
    expect(await check(registered, signal)).toBe(false);
    expect(await check(privateGate, signal)).toBe(false);
    expect(await check(ids[0], signal)).toBe(true);
    expect(deps.canReadContextGraph.mock.calls.map(([id]) => id)).toEqual([registered, privateGate]);
  });

  it.each(['local-state', 'metadata-revision'])('rechecks %s after preparation', async (change) => {
    const deps = dependencies();
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ['candidate'], signal);
    if (change === 'local-state') deps.requiresIndividualRead.mockReturnValue(true);
    else deps.readMetadataRevision.mockReturnValue(1);
    expect(await check('candidate', signal)).toBe(false);
    expect(deps.canReadContextGraph).toHaveBeenCalledOnce();
  });

  it('preserves the existing resolver when the adapter has no bulk capability', async () => {
    const deps = dependencies();
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks({ ...deps, resolveContextGraphIdsByNameHashes: undefined }, ['a'], signal);
    expect(await check('a', signal)).toBe(false);
    expect(deps.findContextGraphIdsWithReadAuthorityFacts).not.toHaveBeenCalled();
    expect(deps.canReadContextGraph).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'extra', 'wrong-key', 'zero', 'overflow'])('rejects %s registration maps without granting an owner', async (malformation) => {
    const deps = dependencies();
    deps.resolveContextGraphIdsByNameHashes.mockImplementation(async (names) => {
      const result = new Map<string, bigint | null>(names.map((name) => [name, null]));
      if (malformation === 'missing' || malformation === 'wrong-key') result.delete(names[0]);
      if (malformation === 'extra' || malformation === 'wrong-key') result.set(commitment('other'), null);
      if (malformation === 'zero') result.set(names[0], 0n);
      if (malformation === 'overflow') result.set(names[0], 1n << 256n);
      return result;
    });
    await expect(prepareUnscopedContextGraphReadChecks(deps, ['a', 'b'], new AbortController().signal))
      .rejects.toThrow(/registration batch/);
    expect(deps.canReadContextGraph).not.toHaveBeenCalled();
  });

  it('binds bulk transport work to the request signal and rejects late completion after abort', async () => {
    const deps = dependencies();
    const stop = new AbortController();
    let release!: () => void;
    deps.resolveContextGraphIdsByNameHashes.mockImplementation(async (names, options) => {
      expect(options.signal.aborted).toBe(false);
      expect(activeRpcRequestContext().signal).toBe(options.signal);
      await new Promise<void>((resolve) => { release = resolve; });
      return new Map(names.map((name) => [name, null]));
    });
    const pending = prepareUnscopedContextGraphReadChecks(deps, ['a'], stop.signal);
    const outcome = expect(pending).rejects.toThrow('cancelled');
    stop.abort(new Error('cancelled'));
    release();
    await outcome;
    expect(deps.canReadContextGraph).not.toHaveBeenCalled();
  });

  it('denies unavailable registration promptly and aborts hanging metadata work', async () => {
    const deps = dependencies();
    let metadataSignal!: AbortSignal;
    deps.findContextGraphIdsWithReadAuthorityFacts.mockImplementation(async (_ids, signal) => {
      metadataSignal = signal;
      return new Promise<ReadonlySet<string>>(() => {});
    });
    deps.resolveContextGraphIdsByNameHashes.mockRejectedValue(new Error('RPC unavailable'));
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, ['a'], signal);
    expect(metadataSignal.aborted).toBe(true);
    expect(await check('a', signal)).toBe(false);
    expect(deps.canReadContextGraph).not.toHaveBeenCalled();
  });

  it('cancels four active metadata batches and never starts queued batches after registration failure', async () => {
    const deps = dependencies();
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const activeSignals: AbortSignal[] = [];
    const releases: Array<() => void> = [];
    let batchesStarted!: () => void;
    const firstFourStarted = new Promise<void>((resolve) => { batchesStarted = resolve; });
    const query = vi.spyOn(store, 'query').mockImplementation(async (_sparql, options) => {
      activeSignals.push(options!.signal!);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        if (releases.length === 4) batchesStarted();
      });
      return { type: 'bindings', bindings: [] };
    });
    deps.findContextGraphIdsWithReadAuthorityFacts.mockImplementation((ids, signal) => (
      projection.findContextGraphIdsWithReadAuthorityFacts(ids, { signal })
    ));
    let rejectRegistration!: (reason: Error) => void;
    deps.resolveContextGraphIdsByNameHashes.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectRegistration = reject;
    }));
    const signal = new AbortController().signal;
    const pending = prepareUnscopedContextGraphReadChecks(
      deps, Array.from({ length: 800 }, (_, i) => `candidate-${i}`), signal,
    );
    await firstFourStarted;
    rejectRegistration(new Error('RPC unavailable'));
    const check = await pending;
    expect(activeSignals.every((activeSignal) => activeSignal.aborted)).toBe(true);
    expect(await check('candidate-799', signal)).toBe(false);
    for (const release of releases) release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(query).toHaveBeenCalledTimes(4);
    expect(deps.canReadContextGraph).not.toHaveBeenCalled();
    await store.close();
  });

  it('yields large commitment preparation so caller cancellation stops before the batch read', async () => {
    const deps = dependencies();
    const stop = new AbortController();
    setImmediate(() => stop.abort(new Error('cancelled while preparing')));
    await expect(prepareUnscopedContextGraphReadChecks(
      deps, Array.from({ length: 2048 }, (_, i) => `candidate-${i}`), stop.signal,
    )).rejects.toThrow('cancelled while preparing');
    expect(deps.resolveContextGraphIdsByNameHashes).not.toHaveBeenCalled();
    expect(deps.contextGraphNameCommitment.mock.calls.length).toBeLessThan(2048);
  });
});

describe('batched local read-authority facts', () => {
  it.each(['meta', 'agents', 'ontology', 'catalog'].flatMap((source) => (
    ['insert', 'replaceSubject'].map((operation) => [source, operation])
  )))('invalidates prepared absence after restricted access rights in %s via %s', async (source, operation) => {
    const rawStore = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(rawStore);
    const store = createListContextGraphsCacheInvalidatingStore(rawStore, () => {}, (quads, targetGraph) => {
      if (targetGraph) projection.markDirtyForGraph(targetGraph);
      else if (quads) projection.markDirtyFromQuads(quads);
      else projection.markAllDirty();
    });
    const id = 'candidate';
    const deps = dependencies();
    deps.readMetadataRevision.mockImplementation(() => projection.readAuthorityFactsRevision);
    deps.findContextGraphIdsWithReadAuthorityFacts.mockImplementation((ids, signal) => (
      projection.findContextGraphIdsWithReadAuthorityFacts(ids, { signal })
    ));
    deps.canReadContextGraph.mockImplementation(async (candidate) => (
      (await projection.get(candidate)).accessPolicy !== 'private'
    ));
    const signal = new AbortController().signal;
    const check = await prepareUnscopedContextGraphReadChecks(deps, [id], signal);
    expect(await check(id, signal)).toBe(true);
    const graphs: Record<string, string> = {
      meta: contextGraphMetaUri(id), catalog: contextGraphCatalogUri(id),
      agents: contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.AGENTS),
      ontology: contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
    };
    const quads = [{ subject: contextGraphDataUri(id), graph: graphs[source],
      predicate: DKG_ONTOLOGY.DCT_ACCESS_RIGHTS, object: DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED }];
    if (operation === 'insert') await store.insert(quads);
    else await store.replaceSubject!(graphs[source], contextGraphDataUri(id), quads);
    expect((await projection.get(id)).accessPolicy).toBe('private');
    expect(await check(id, signal)).toBe(false);
    expect(deps.canReadContextGraph).toHaveBeenCalledWith(id, signal);
    await store.close();
  });

  it('covers exact owner facts in every projection source, including gate-only metadata', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const ids = ['tenant/meta', 'tenant/agents', 'tenant/catalog', 'tenant/ontology', 'ordinary'];
    const sources = [contextGraphMetaUri(ids[0]), contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.AGENTS),
      contextGraphCatalogUri(ids[2]), contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)];
    await store.insert(ids.slice(0, 4).map((id, index) => ({
      subject: contextGraphDataUri(id), graph: sources[index],
      predicate: index === 0 ? DKG_ONTOLOGY.DKG_ALLOWED_AGENT : DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: index === 0 ? 'did:dkg:agent:outsider' : '"private"',
    })));
    await store.insert([{ subject: 'urn:unrelated', predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"private"', graph: contextGraphMetaUri('ordinary') }]);
    expect(await projection.findContextGraphIdsWithReadAuthorityFacts(ids)).toEqual(new Set(ids.slice(0, 4)));
    await store.close();
  });

  it('queries bounded batches and finds metadata after the old 512-candidate boundary', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const ids = Array.from({ length: 600 }, (_, i) => `public/partition/${i}`);
    await store.insert([{ subject: contextGraphDataUri(ids[599]), predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
      object: '"peer-private"', graph: contextGraphMetaUri(ids[599]) }]);
    const query = vi.spyOn(store, 'query');
    expect(await projection.findContextGraphIdsWithReadAuthorityFacts(ids)).toEqual(new Set([ids[599]]));
    expect(query).toHaveBeenCalledTimes(5);
    for (const [sparql] of query.mock.calls) expect((sparql.match(/\(<did:dkg:context-graph:/g) ?? []).length).toBeLessThanOrEqual(128);
    await store.close();
  });

  it('retains cached restrictive authority even if its original store facts have disappeared', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'cached-private';
    await store.insert([{ subject: contextGraphDataUri(id), predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"private"', graph: contextGraphMetaUri(id) }]);
    await projection.get(id);
    await store.dropGraph(contextGraphMetaUri(id));
    expect(await projection.findContextGraphIdsWithReadAuthorityFacts([id])).toEqual(new Set([id]));
    const before = projection.readAuthorityFactsRevision;
    projection.markDirty(id);
    expect(projection.readAuthorityFactsRevision).not.toBe(before);
    await store.close();
  });

  it('rejects malformed local discovery instead of treating it as absence', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    vi.spyOn(store, 'query').mockResolvedValue({ type: 'boolean', value: false });
    await expect(projection.findContextGraphIdsWithReadAuthorityFacts(['a'])).rejects.toThrow(/invalid local read-authority/);
    await store.close();
  });
});
