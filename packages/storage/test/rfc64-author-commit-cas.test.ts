import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATOMIC_GRAPH_REPLACE_STAGING_PREFIX,
  BlazegraphStore,
  ChangelogStore,
  EXTERNAL_LITERAL_REF_DATATYPE,
  GraphSetIndexStore,
  OxigraphStore,
  RFC64_AUTHOR_COMMIT_MAX_STATE_REPLACEMENTS_V1,
  RFC64_AUTHOR_COMMIT_MAX_CONTROL_QUADS_V1,
  SharedMemoryLiteralBlobStore,
  SparqlHttpStore,
  UnsupportedTripleStoreCapabilityError,
  buildRfc64AuthorCommitCasUpdateV1,
  createTripleStore,
  executeRfc64AuthorCommitCasV1,
  tryRfc64AuthorCommitCasV1,
  type Quad,
  type QueryOptions,
  type Rfc64AuthorCommitCasInputV1,
  type TripleStore,
} from '../src/index.js';

const PROJECTION_GRAPH = 'did:dkg:context-graph:rfc64/_shared_memory';
const SEAL_GRAPH = 'urn:test:rfc64:seals';
const HEAD_GRAPH = 'urn:test:rfc64:heads';
const STATE_GRAPH = 'urn:test:rfc64:state';
const OTHER_GRAPH = 'urn:test:rfc64:unrelated';
const AUTHOR = 'urn:test:rfc64:author:alice';
const SEAL = 'urn:test:rfc64:seal:alice';
const KA_STATE = 'urn:test:rfc64:ka-state';
const MUTATION = 'urn:test:rfc64:mutation:subgraph';
const CG_MUTATION = 'urn:test:rfc64:mutation:context-graph';
const APPLIED_SET = 'urn:test:rfc64:applied-set';
const INVALIDATED_SEAL = 'urn:test:rfc64:seal:stale';
const P_VALUE = 'urn:test:rfc64:value';
const P_HEAD = 'urn:test:rfc64:current-head';
const P_GENERATION = 'urn:test:rfc64:generation';
const P_APPLIED = 'urn:test:rfc64:applied';
const OLD_HEAD = 'urn:test:rfc64:catalog:old';
const NEW_HEAD = 'urn:test:rfc64:catalog:new';

function quad(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

function authorCommitInput(
  overrides: Partial<Rfc64AuthorCommitCasInputV1> = {},
): Rfc64AuthorCommitCasInputV1 {
  return {
    sharedProjectionGraph: PROJECTION_GRAPH,
    sharedProjectionQuads: [
      quad('urn:test:rfc64:new:1', P_VALUE, '"new-1"', PROJECTION_GRAPH),
      quad('urn:test:rfc64:new:2', P_VALUE, '"new-2"', PROJECTION_GRAPH),
    ],
    authorSealGraph: SEAL_GRAPH,
    authorSealSubject: SEAL,
    authorSealQuads: [quad(SEAL, P_VALUE, '"new-seal"', SEAL_GRAPH)],
    currentHeadGraph: HEAD_GRAPH,
    currentHeadSubject: AUTHOR,
    currentHeadPredicate: P_HEAD,
    expectedCurrentHeadObject: OLD_HEAD,
    nextCurrentHeadObject: NEW_HEAD,
    kaStateDigest: {
      graphUri: STATE_GRAPH,
      subject: KA_STATE,
      predicate: P_VALUE,
      expectedObject: OLD_HEAD,
      quads: [quad(KA_STATE, P_VALUE, NEW_HEAD, STATE_GRAPH)],
    },
    subgraphMutationGeneration: {
      graphUri: STATE_GRAPH,
      subject: MUTATION,
      predicate: P_GENERATION,
      expectedObject: '"1"',
      quads: [quad(MUTATION, P_GENERATION, '"2"', STATE_GRAPH)],
    },
    contextGraphMutationGeneration: {
      graphUri: STATE_GRAPH,
      subject: CG_MUTATION,
      predicate: P_GENERATION,
      expectedObject: '"10"',
      quads: [quad(CG_MUTATION, P_GENERATION, '"11"', STATE_GRAPH)],
    },
    appliedSet: {
      graphUri: STATE_GRAPH,
      subject: APPLIED_SET,
      predicate: P_APPLIED,
      expectedObject: OLD_HEAD,
      quads: [quad(APPLIED_SET, P_APPLIED, NEW_HEAD, STATE_GRAPH)],
    },
    sealInvalidations: [],
    ...overrides,
  };
}

async function seedOldState(store: TripleStore): Promise<void> {
  await store.insert([
    quad('urn:test:rfc64:old', P_VALUE, '"old"', PROJECTION_GRAPH),
    quad(SEAL, P_VALUE, '"old-seal"', SEAL_GRAPH),
    quad(AUTHOR, P_HEAD, OLD_HEAD, HEAD_GRAPH),
    quad(KA_STATE, P_VALUE, OLD_HEAD, STATE_GRAPH),
    quad(MUTATION, P_GENERATION, '"1"', STATE_GRAPH),
    quad(CG_MUTATION, P_GENERATION, '"10"', STATE_GRAPH),
    quad(APPLIED_SET, P_APPLIED, OLD_HEAD, STATE_GRAPH),
    quad('urn:test:rfc64:keep', P_VALUE, '"keep"', OTHER_GRAPH),
  ]);
}

async function objectFor(
  store: TripleStore,
  graph: string,
  subject: string,
  predicate: string,
): Promise<string | undefined> {
  const result = await store.query(
    `SELECT ?o WHERE { GRAPH <${graph}> { <${subject}> <${predicate}> ?o } }`,
  );
  if (result.type !== 'bindings') throw new Error('expected bindings result');
  return result.bindings[0]?.o;
}

function overrideStore(base: TripleStore, overrides: Partial<TripleStore>): TripleStore {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in overrides) return (overrides as Record<string | symbol, unknown>)[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TripleStore;
}

describe('RFC-64 certified author commit CAS v1', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  describe('receipt executor failure contract', () => {
    it('preserves an update failure when best-effort cleanup also fails', async () => {
      const updateError = new Error('update response lost');
      const cleanup = vi.fn().mockRejectedValue(new Error('cleanup failed'));
      const readReceipt = vi.fn();
      const onCommitted = vi.fn();

      const error = await executeRfc64AuthorCommitCasV1({
        executeUpdate: () => { throw updateError; },
        readReceipt,
        cleanup,
        onCommitted,
      }).catch((reason: unknown) => reason);

      expect(error).toBe(updateError);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(readReceipt).not.toHaveBeenCalled();
      expect(onCommitted).not.toHaveBeenCalled();
    });

    it.each([
      ['receipt rejection', () => { throw new Error('receipt transport failed'); }],
      ['malformed receipt', () => ({ type: 'bindings', bindings: [] })],
    ])('preserves an indeterminate %s and still attempts cleanup', async (_name, read) => {
      const cleanup = vi.fn().mockRejectedValue(new Error('cleanup failed'));
      const onCommitted = vi.fn();

      const error = await executeRfc64AuthorCommitCasV1({
        executeUpdate: vi.fn(),
        readReceipt: read,
        cleanup,
        onCommitted,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/receipt (transport failed|query returned)/);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(onCommitted).not.toHaveBeenCalled();
    });

    it.each([
      [false, 'conflict', 0],
      [true, 'committed', 1],
    ] as const)(
      'keeps the %s receipt outcome when cleanup fails',
      async (receipt, expected, committedCalls) => {
        const cleanup = vi.fn().mockRejectedValue(new Error('cleanup failed'));
        const onCommitted = vi.fn();

        await expect(executeRfc64AuthorCommitCasV1({
          executeUpdate: vi.fn(),
          readReceipt: () => receipt,
          cleanup,
          onCommitted,
        })).resolves.toBe(expected);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(onCommitted).toHaveBeenCalledTimes(committedCalls);
      },
    );
  });

  it('commits the projection, seal, head, and bounded state old-or-new together', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput())).resolves.toBe('committed');

    const projection = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${PROJECTION_GRAPH}> { ?s <${P_VALUE}> ?o } } ORDER BY ?s`,
    );
    expect(projection.type === 'bindings' ? projection.bindings : []).toEqual([
      { s: 'urn:test:rfc64:new:1', o: '"new-1"' },
      { s: 'urn:test:rfc64:new:2', o: '"new-2"' },
    ]);
    expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"new-seal"');
    expect(await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(NEW_HEAD);
    expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBe('"2"');
    expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(NEW_HEAD);
    expect(await store.countQuads(OTHER_GRAPH)).toBe(1);
    expect((await store.listGraphs()).some(
      (graph) => graph.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX),
    )).toBe(false);
  });

  it('returns a clean conflict and changes no semantic target when any guard is stale', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const base = authorCommitInput();
    const input = authorCommitInput({
      subgraphMutationGeneration: {
        ...base.subgraphMutationGeneration,
        expectedObject: '"stale"',
      },
    });

    await expect(store.rfc64AuthorCommitCasV1!(input)).resolves.toBe('conflict');

    expect(await objectFor(store, PROJECTION_GRAPH, 'urn:test:rfc64:old', P_VALUE)).toBe('"old"');
    expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"old-seal"');
    expect(await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(OLD_HEAD);
    expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBe('"1"');
    expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(OLD_HEAD);
    expect((await store.listGraphs()).some(
      (graph) => graph.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX),
    )).toBe(false);
  });

  it('honors Oxigraph pre-dispatch cancellation without changing any semantic target', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled before CAS dispatch'));

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput(), {
      signal: controller.signal,
    })).rejects.toThrow('caller cancelled before CAS dispatch');

    expect(await objectFor(store, PROJECTION_GRAPH, 'urn:test:rfc64:old', P_VALUE)).toBe('"old"');
    expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"old-seal"');
    expect(await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(OLD_HEAD);
    expect(await objectFor(store, STATE_GRAPH, KA_STATE, P_VALUE)).toBe(OLD_HEAD);
    expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBe('"1"');
    expect(await objectFor(store, STATE_GRAPH, CG_MUTATION, P_GENERATION)).toBe('"10"');
    expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(OLD_HEAD);
  });

  it('rejects an oversized non-SWM current-head literal before remote dispatch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://oversized-head.test/query',
      updateEndpoint: 'http://oversized-head.test/update',
      consistencyProfile: 'atomic-readback',
    });

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput({
      nextCurrentHeadObject: `"${'x'.repeat(65_536)}"`,
    }))).rejects.toThrow(/safe limit of 65535 bytes/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enforces exact-value and absent-value guard semantics', async () => {
    const multiValued = new OxigraphStore();
    await seedOldState(multiValued);
    await multiValued.insert([
      quad(MUTATION, P_GENERATION, '"unexpected"', STATE_GRAPH),
    ]);
    await expect(multiValued.rfc64AuthorCommitCasV1!(authorCommitInput()))
      .resolves.toBe('conflict');
    expect(await objectFor(multiValued, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(OLD_HEAD);
    expect(await objectFor(multiValued, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"old-seal"');
    expect(await objectFor(
      multiValued,
      PROJECTION_GRAPH,
      'urn:test:rfc64:old',
      P_VALUE,
    )).toBe('"old"');
    expect(await objectFor(multiValued, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(OLD_HEAD);

    const absent = new OxigraphStore();
    await seedOldState(absent);
    await absent.delete([quad(KA_STATE, P_VALUE, OLD_HEAD, STATE_GRAPH)]);
    const base = authorCommitInput();
    const absentInput = authorCommitInput({
      kaStateDigest: {
        ...base.kaStateDigest,
        expectedObject: null,
      },
    });
    await expect(absent.rfc64AuthorCommitCasV1!(absentInput)).resolves.toBe('committed');

    const present = new OxigraphStore();
    await seedOldState(present);
    await expect(present.rfc64AuthorCommitCasV1!(absentInput)).resolves.toBe('conflict');
    expect(await objectFor(present, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(OLD_HEAD);
    expect(await objectFor(present, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"old-seal"');
    expect(await objectFor(
      present,
      PROJECTION_GRAPH,
      'urn:test:rfc64:old',
      P_VALUE,
    )).toBe('"old"');
    expect(await objectFor(present, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(OLD_HEAD);
  });

  it('rejects the second of two serial writers that use the same guarded head', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const first = authorCommitInput();
    const secondHead = 'urn:test:rfc64:catalog:competing';
    const second = authorCommitInput({
      nextCurrentHeadObject: secondHead,
      sharedProjectionQuads: [
        quad('urn:test:rfc64:competing', P_VALUE, '"competing"', PROJECTION_GRAPH),
      ],
      authorSealQuads: [quad(SEAL, P_VALUE, '"competing-seal"', SEAL_GRAPH)],
      kaStateDigest: {
        ...authorCommitInput().kaStateDigest,
        quads: [quad(KA_STATE, P_VALUE, secondHead, STATE_GRAPH)],
      },
      subgraphMutationGeneration: {
        ...authorCommitInput().subgraphMutationGeneration,
        quads: [quad(MUTATION, P_GENERATION, '"3"', STATE_GRAPH)],
      },
      contextGraphMutationGeneration: {
        ...authorCommitInput().contextGraphMutationGeneration,
        quads: [quad(CG_MUTATION, P_GENERATION, '"12"', STATE_GRAPH)],
      },
      appliedSet: {
        ...authorCommitInput().appliedSet,
        quads: [quad(APPLIED_SET, P_APPLIED, secondHead, STATE_GRAPH)],
      },
    });

    const results = [
      await store.rfc64AuthorCommitCasV1!(first),
      await store.rfc64AuthorCommitCasV1!(second),
    ];
    expect(results.sort()).toEqual(['committed', 'conflict']);

    const head = await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD);
    if (head === NEW_HEAD) {
      expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"new-seal"');
      expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBe('"2"');
      expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(NEW_HEAD);
      expect(await objectFor(store, PROJECTION_GRAPH, 'urn:test:rfc64:new:1', P_VALUE)).toBe('"new-1"');
    } else {
      expect(head).toBe(secondHead);
      expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"competing-seal"');
      expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBe('"3"');
      expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(secondHead);
      expect(await objectFor(store, PROJECTION_GRAPH, 'urn:test:rfc64:competing', P_VALUE)).toBe('"competing"');
    }
  });

  it('can atomically invalidate bounded state subjects without retracting the asset', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const base = authorCommitInput();
    const input = authorCommitInput({
      kaStateDigest: { ...base.kaStateDigest, quads: [] },
      subgraphMutationGeneration: {
        ...base.subgraphMutationGeneration,
        quads: [],
      },
      contextGraphMutationGeneration: {
        ...base.contextGraphMutationGeneration,
        quads: [],
      },
      appliedSet: {
        ...base.appliedSet,
        quads: [],
      },
    });

    await expect(store.rfc64AuthorCommitCasV1!(input)).resolves.toBe('committed');
    expect(await store.countQuads(PROJECTION_GRAPH)).toBe(2);
    expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"new-seal"');
    expect(await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(NEW_HEAD);
    expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBeUndefined();
    expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBeUndefined();
    expect(await store.countQuads(OTHER_GRAPH)).toBe(1);
  });

  it('applies seal invalidations only when every guard commits', async () => {
    const committed = new OxigraphStore();
    await seedOldState(committed);
    await committed.insert([
      quad(INVALIDATED_SEAL, P_VALUE, '"stale-seal"', SEAL_GRAPH),
    ]);
    const invalidation = {
      graphUri: SEAL_GRAPH,
      subject: INVALIDATED_SEAL,
      quads: [],
    } as const;

    await expect(committed.rfc64AuthorCommitCasV1!(authorCommitInput({
      sealInvalidations: [invalidation],
    }))).resolves.toBe('committed');
    expect(await objectFor(committed, SEAL_GRAPH, INVALIDATED_SEAL, P_VALUE)).toBeUndefined();

    const conflicted = new OxigraphStore();
    await seedOldState(conflicted);
    await conflicted.insert([
      quad(INVALIDATED_SEAL, P_VALUE, '"stale-seal"', SEAL_GRAPH),
    ]);
    const base = authorCommitInput();
    await expect(conflicted.rfc64AuthorCommitCasV1!(authorCommitInput({
      subgraphMutationGeneration: {
        ...base.subgraphMutationGeneration,
        expectedObject: '"stale"',
      },
      sealInvalidations: [invalidation],
    }))).resolves.toBe('conflict');
    expect(await objectFor(conflicted, SEAL_GRAPH, INVALIDATED_SEAL, P_VALUE)).toBe('"stale-seal"');
  });

  it('bumps affected write generations only for a committed CAS', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const affectedPrefix = 'did:dkg:context-graph:rfc64/';
    const unrelatedPrefix = 'did:dkg:context-graph:unrelated/';
    const affectedBefore = store.getWriteGen(affectedPrefix);
    const unrelatedBefore = store.getWriteGen(unrelatedPrefix);

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput())).resolves.toBe('committed');
    const affectedAfterCommit = store.getWriteGen(affectedPrefix);
    expect(affectedAfterCommit).toBeGreaterThan(affectedBefore);
    expect(store.getWriteGen(unrelatedPrefix)).toBe(unrelatedBefore);

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput())).resolves.toBe('conflict');
    expect(store.getWriteGen(affectedPrefix)).toBe(affectedAfterCommit);
    expect(store.getWriteGen(unrelatedPrefix)).toBe(unrelatedBefore);
  });

  it('keeps remote semantic write generations stable on a clean conflict', async () => {
    let receiptValue = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (String(init?.body ?? '').includes('ASK')) {
        return new Response(JSON.stringify({ boolean: receiptValue }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      return new Response(null, { status: 200 });
    });
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://write-gen.test/query',
      updateEndpoint: 'http://write-gen.test/update',
      consistencyProfile: 'atomic-readback',
    });
    const affectedPrefix = 'did:dkg:context-graph:rfc64/';
    const unrelatedPrefix = 'did:dkg:context-graph:unrelated/';
    const affectedBefore = store.getWriteGen(affectedPrefix);
    const unrelatedBefore = store.getWriteGen(unrelatedPrefix);

    await expect(store.rfc64AuthorCommitCasV1(authorCommitInput())).resolves.toBe('committed');
    const affectedAfterCommit = store.getWriteGen(affectedPrefix);
    expect(affectedAfterCommit).toBeGreaterThan(affectedBefore);
    expect(store.getWriteGen(unrelatedPrefix)).toBe(unrelatedBefore);

    receiptValue = false;
    await expect(store.rfc64AuthorCommitCasV1(authorCommitInput())).resolves.toBe('conflict');
    expect(store.getWriteGen(affectedPrefix)).toBe(affectedAfterCommit);
    expect(store.getWriteGen(unrelatedPrefix)).toBe(unrelatedBefore);
  });

  it('preserves the capability through literal, graph-index, and changelog decorators', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-author-commit-blobs-'));
    tempDirs.push(blobDir);
    const raw = new OxigraphStore();
    const blobs = new SharedMemoryLiteralBlobStore(raw, { blobDir, thresholdBytes: 20 });
    const indexed = new GraphSetIndexStore(blobs, { revalidateMs: 60_000 });
    const records: Array<{ graph: string; op: string }> = [];
    const store = new ChangelogStore(indexed, {
      onAppend: ({ graph, op }) => records.push({ graph, op }),
    });
    await seedOldState(store);
    records.length = 0;
    const largeLiteral = `"${'large-public-swm-value'.repeat(10)}"`;

    await expect(tryRfc64AuthorCommitCasV1(store, authorCommitInput({
      sharedProjectionQuads: [
        quad('urn:test:rfc64:new:large', P_VALUE, largeLiteral, PROJECTION_GRAPH),
      ],
    }))).resolves.toBe('committed');

    expect(await objectFor(store, PROJECTION_GRAPH, 'urn:test:rfc64:new:large', P_VALUE)).toBe(
      largeLiteral,
    );
    const rawObject = await objectFor(
      raw,
      PROJECTION_GRAPH,
      'urn:test:rfc64:new:large',
      P_VALUE,
    );
    expect(rawObject).toMatch(
      new RegExp(`^"sha256:[0-9a-f]{64}"\\^\\^<${EXTERNAL_LITERAL_REF_DATATYPE}>$`),
    );
    expect(records).toEqual([
      { graph: PROJECTION_GRAPH, op: 'upsert' },
      { graph: SEAL_GRAPH, op: 'upsert' },
      { graph: HEAD_GRAPH, op: 'upsert' },
      { graph: STATE_GRAPH, op: 'upsert' },
    ]);
    expect(await store.listGraphs()).toEqual(expect.arrayContaining([
      PROJECTION_GRAPH,
      SEAL_GRAPH,
      HEAD_GRAPH,
      STATE_GRAPH,
    ]));

    records.length = 0;
    await expect(tryRfc64AuthorCommitCasV1(store, authorCommitInput())).resolves.toBe('conflict');
    expect(records).toEqual([]);
  });

  it('translates oversized scalar guards and next values through the blob representation', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-scalar-blobs-'));
    tempDirs.push(blobDir);
    const raw = new OxigraphStore();
    const store = new SharedMemoryLiteralBlobStore(raw, { blobDir, thresholdBytes: 20 });
    await seedOldState(store);
    const scalarGraph = 'did:dkg:context-graph:rfc64/control/_shared_memory';
    const oldValue = `"${'old-guard-value'.repeat(10)}"`;
    const nextValue = `"${'next-guard-value'.repeat(10)}"`;
    await store.insert([quad(KA_STATE, P_VALUE, oldValue, scalarGraph)]);
    const input = authorCommitInput({
      kaStateDigest: {
        graphUri: scalarGraph,
        subject: KA_STATE,
        predicate: P_VALUE,
        expectedObject: oldValue,
        quads: [quad(KA_STATE, P_VALUE, nextValue, scalarGraph)],
      },
      currentHeadGraph: scalarGraph,
      currentHeadSubject: AUTHOR,
      currentHeadPredicate: P_HEAD,
      expectedCurrentHeadObject: null,
      nextCurrentHeadObject: nextValue,
    });
    await expect(store.rfc64AuthorCommitCasV1(input)).resolves.toBe('committed');
    expect(await objectFor(store, scalarGraph, KA_STATE, P_VALUE)).toBe(nextValue);
    expect(await objectFor(store, scalarGraph, AUTHOR, P_HEAD)).toBe(nextValue);
  });

  it('retains newly-created literal blobs after a clean conflict for reference-aware GC', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-conflict-blobs-'));
    tempDirs.push(blobDir);
    const base = new OxigraphStore();
    const inner = overrideStore(base, {
      rfc64AuthorCommitCasV1: async () => 'conflict',
    });
    const store = new SharedMemoryLiteralBlobStore(inner, { blobDir, thresholdBytes: 20 });
    const largeLiteral = `"${'conflicting-value'.repeat(20)}"`;

    await expect(store.rfc64AuthorCommitCasV1(authorCommitInput({
      sharedProjectionQuads: [
        quad('urn:test:rfc64:conflict', P_VALUE, largeLiteral, PROJECTION_GRAPH),
      ],
    }))).resolves.toBe('conflict');
    expect(await readdir(blobDir)).toHaveLength(1);
  });

  it('preserves pre-existing and concurrently committed shared blob hashes', async () => {
    const preexistingDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-shared-blob-'));
    tempDirs.push(preexistingDir);
    const largeLiteral = `"${'shared-value'.repeat(30)}"`;
    const preexistingInner = overrideStore(new OxigraphStore(), {
      rfc64AuthorCommitCasV1: async () => 'conflict',
    });
    const preexisting = new SharedMemoryLiteralBlobStore(
      preexistingInner,
      { blobDir: preexistingDir, thresholdBytes: 20 },
    );
    await preexisting.insert([
      quad('urn:test:rfc64:existing', P_VALUE, largeLiteral, PROJECTION_GRAPH),
    ]);
    const existingFiles = await readdir(preexistingDir);
    await expect(preexisting.rfc64AuthorCommitCasV1(authorCommitInput({
      sharedProjectionQuads: [
        quad('urn:test:rfc64:conflict', P_VALUE, largeLiteral, PROJECTION_GRAPH),
      ],
    }))).resolves.toBe('conflict');
    expect(await readdir(preexistingDir)).toEqual(existingFiles);

    const concurrentDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-concurrent-blob-'));
    tempDirs.push(concurrentDir);
    let entered = 0;
    let releaseBoth!: () => void;
    const bothEntered = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const concurrentInner = overrideStore(new OxigraphStore(), {
      rfc64AuthorCommitCasV1: async () => {
        const writer = entered++;
        if (entered === 2) releaseBoth();
        await bothEntered;
        return writer === 0 ? 'committed' : 'conflict';
      },
    });
    const concurrent = new SharedMemoryLiteralBlobStore(
      concurrentInner,
      { blobDir: concurrentDir, thresholdBytes: 20 },
    );
    const manifest = authorCommitInput({
      sharedProjectionQuads: [
        quad('urn:test:rfc64:concurrent', P_VALUE, largeLiteral, PROJECTION_GRAPH),
      ],
    });
    await expect(Promise.all([
      concurrent.rfc64AuthorCommitCasV1(manifest),
      concurrent.rfc64AuthorCommitCasV1(manifest),
    ])).resolves.toEqual(['committed', 'conflict']);
    expect(await readdir(concurrentDir)).toHaveLength(1);
  });

  it('flags changelog reconciliation after an indeterminate post-commit failure', async () => {
    const base = new OxigraphStore();
    await seedOldState(base);
    const inner = overrideStore(base, {
      rfc64AuthorCommitCasV1: async (
        input: Rfc64AuthorCommitCasInputV1,
        options?: QueryOptions,
      ) => {
        await base.rfc64AuthorCommitCasV1!(input, options);
        throw new Error('response lost after commit');
      },
    });
    const store = new ChangelogStore(inner);

    await expect(store.rfc64AuthorCommitCasV1(authorCommitInput())).rejects.toThrow(
      'response lost after commit',
    );
    expect(store.needsReconcile).toBe(true);
    expect(await objectFor(base, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(NEW_HEAD);
  });

  it('rebuilds a warm graph index after an indeterminate RFC-64 commit response', async () => {
    const base = new OxigraphStore();
    await seedOldState(base);
    const committedGraph = 'urn:test:rfc64:new-seal-graph';
    const committedInput = authorCommitInput({
      authorSealGraph: committedGraph,
      authorSealQuads: [quad(SEAL, P_VALUE, '"new-seal"', committedGraph)],
    });
    let scans = 0;
    const inner = overrideStore(base, {
      listGraphs: async (options?: QueryOptions) => {
        scans += 1;
        return base.listGraphs(options);
      },
      rfc64AuthorCommitCasV1: async (input, options) => {
        await base.rfc64AuthorCommitCasV1!(input, options);
        throw new Error('RFC-64 response lost after commit');
      },
    });
    const store = new GraphSetIndexStore(inner, { revalidateMs: 60_000 });
    expect(await store.listGraphs()).not.toContain(committedGraph);
    expect(scans).toBe(1);

    await expect(store.rfc64AuthorCommitCasV1(committedInput))
      .rejects.toThrow('RFC-64 response lost after commit');
    expect(await store.listGraphs()).toEqual(expect.arrayContaining([
      PROJECTION_GRAPH,
      committedGraph,
      HEAD_GRAPH,
      STATE_GRAPH,
    ]));
    expect(scans).toBe(2);
  });

  it('keeps a warm graph index on RFC-64 conflict and proven not-started refusal', async () => {
    for (const outcome of ['conflict', 'not-started'] as const) {
      const base = new OxigraphStore();
      await base.insert([quad('urn:test:rfc64:warm', P_VALUE, '"warm"', OTHER_GRAPH)]);
      let scans = 0;
      const inner = overrideStore(base, {
        listGraphs: async (options?: QueryOptions) => {
          scans += 1;
          return base.listGraphs(options);
        },
        rfc64AuthorCommitCasV1: async () => {
          if (outcome === 'not-started') {
            throw new UnsupportedTripleStoreCapabilityError(
              'rfc64AuthorCommitCasV1',
              'refusing-test-store',
            );
          }
          return 'conflict';
        },
      });
      const store = new GraphSetIndexStore(inner, { revalidateMs: 60_000 });
      expect(await store.listGraphs()).toEqual([OTHER_GRAPH]);
      expect(scans).toBe(1);

      if (outcome === 'conflict') {
        await expect(store.rfc64AuthorCommitCasV1(authorCommitInput()))
          .resolves.toBe('conflict');
      } else {
        await expect(store.rfc64AuthorCommitCasV1(authorCommitInput()))
          .rejects.toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
      }
      expect(await store.listGraphs()).toEqual([OTHER_GRAPH]);
      expect(scans).toBe(1);
    }
  });

  it('fails closed on unsupported and non-transactional endpoints before any request', async () => {
    const base = new OxigraphStore();
    const unsupported = overrideStore(base, { rfc64AuthorCommitCasV1: undefined });
    await expect(tryRfc64AuthorCommitCasV1(unsupported, authorCommitInput())).resolves.toBeNull();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const remote = new SparqlHttpStore({ queryEndpoint: 'http://unsupported.invalid/sparql' });
    await expect(tryRfc64AuthorCommitCasV1(remote, authorCommitInput())).resolves.toBeNull();
    const transactionalButReplicaUnsafe = new SparqlHttpStore({
      queryEndpoint: 'http://unsupported.invalid/query-replica',
      updateEndpoint: 'http://unsupported.invalid/update-primary',
      consistencyProfile: 'atomic-update',
    });
    await expect(tryRfc64AuthorCommitCasV1(
      transactionalButReplicaUnsafe,
      authorCommitInput(),
    )).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves receipt certification through the managed factory decorator stack', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = String(init?.body ?? '');
      if (body.includes('ASK')) {
        return new Response(JSON.stringify({ boolean: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      return new Response(null, { status: 200 });
    });
    const store = await createTripleStore({
      backend: 'sparql-http',
      options: {
        queryEndpoint: 'http://managed-rfc64.test/query',
        updateEndpoint: 'http://managed-rfc64.test/update',
        managedByDkg: true,
      },
    });
    try {
      await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput()))
        .resolves.toBe('committed');
    } finally {
      await store.close();
    }
  });

  it.each([
    ['Blazegraph', () => new BlazegraphStore('http://rfc64.test/sparql') as TripleStore],
    ['transactional SPARQL HTTP', () => new SparqlHttpStore({
      queryEndpoint: 'http://rfc64.test/query',
      updateEndpoint: 'http://rfc64.test/update',
      consistencyProfile: 'atomic-readback',
    }) as TripleStore],
  ])('uses the certified update and receipt protocol on %s', async (_name, createStore) => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const body = String(init?.body ?? '');
      requests.push({ url: String(input), body });
      if (body.includes('ASK')) {
        return new Response(JSON.stringify({ boolean: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      return new Response(null, { status: 200 });
    });
    const store = createStore();

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput())).resolves.toBe('committed');

    expect(requests).toHaveLength(3);
    expect(requests[0]!.body).toContain('urn:dkg:sync:authorCommitApplied');
    expect(requests[0]!.body).toContain(`GRAPH <${PROJECTION_GRAPH}>`);
    expect(requests[0]!.body).toContain(`GRAPH <${HEAD_GRAPH}>`);
    expect(requests[1]!.body).toContain('ASK');
    expect(requests[2]!.body).toContain('DROP SILENT GRAPH');
  });

  it('rejects ambiguous or unbounded fixed-manifest inputs before building an update', () => {
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      authorSealGraph: PROJECTION_GRAPH,
    }))).toThrow(/author seal cannot share/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      sharedProjectionQuads: [],
    }))).toThrow(/non-empty shared projection/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      authorSealQuads: [],
    }))).toThrow(/non-empty author seal/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      authorSealSubject: '_:seal',
    }))).toThrow(/canonical IRI/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      nextCurrentHeadObject: '_:next-head',
    }))).toThrow(/blank node/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      subgraphMutationGeneration: {
        ...authorCommitInput().subgraphMutationGeneration,
        expectedObject: '_:generation',
      },
    }))).toThrow(/blank node/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      expectedCurrentHeadObject: NEW_HEAD,
    }))).toThrow(/must advance/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      expectedCurrentHeadObject: `<${NEW_HEAD}>`,
    }))).toThrow(/must advance/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1({
      ...authorCommitInput(),
      kaStateDigest: undefined,
    } as unknown as Rfc64AuthorCommitCasInputV1)).toThrow(/exact kaStateDigest semantic transition/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      sealInvalidations: Array.from(
        { length: RFC64_AUTHOR_COMMIT_MAX_STATE_REPLACEMENTS_V1 - 3 },
        (_, index) => ({
          graphUri: STATE_GRAPH,
          subject: `urn:test:rfc64:replacement:${index}`,
          quads: [],
        }),
      ),
    }))).toThrow(/at most .* state replacements/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      appliedSet: {
        ...authorCommitInput().appliedSet,
        graphUri: authorCommitInput().kaStateDigest.graphUri,
        subject: authorCommitInput().kaStateDigest.subject,
        predicate: authorCommitInput().kaStateDigest.predicate,
      },
    }))).toThrow(/duplicate guard/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      subgraphMutationGeneration: {
        ...authorCommitInput().subgraphMutationGeneration,
        graphUri: `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}guard`,
      },
    }))).toThrow(/internal atomic graph/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      appliedSet: {
        ...authorCommitInput().appliedSet,
        graphUri: authorCommitInput().kaStateDigest.graphUri,
        subject: authorCommitInput().kaStateDigest.subject,
      },
    }))).toThrow(/duplicate subject replacement/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      sharedProjectionGraph: `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}forbidden`,
      sharedProjectionQuads: [quad(
        'urn:test:rfc64:forbidden',
        P_VALUE,
        '"value"',
        `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}forbidden`,
      )],
    }))).toThrow(/internal atomic graph/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      authorSealQuads: Array.from(
        { length: RFC64_AUTHOR_COMMIT_MAX_CONTROL_QUADS_V1 },
        (_, index) => quad(SEAL, `urn:test:rfc64:seal-value:${index}`, '"value"', SEAL_GRAPH),
      ),
    }))).toThrow(/control payload exceeds/i);
  });
});
