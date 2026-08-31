import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTERNAL_LITERAL_REF_DATATYPE,
  OxigraphStore,
  SharedMemoryLiteralBlobStore,
  UnsupportedTripleStoreCapabilityError,
  createTripleStore,
  type QueryOptions,
  type QueryResult,
  type Quad,
  type Rfc64AuthorCommitCasInputV1,
  type TripleStore,
} from '../src/index.js';
import { normalizeRfc64AuthorCommitCasV1 } from '../src/rfc64-author-commit-cas.js';

const SWM_GRAPH = 'did:dkg:context-graph:test/_shared_memory';
const NON_SWM_GRAPH = 'did:dkg:context-graph:test';

describe('SharedMemoryLiteralBlobStore', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempBlobDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-storage-literal-blobs-'));
    tempDirs.push(dir);
    return dir;
  }

  it('externalizes only large SWM literal object terms and hydrates SELECT and CONSTRUCT results', async () => {
    const blobDir = await tempBlobDir();
    const inner = new OxigraphStore();
    const store = new SharedMemoryLiteralBlobStore(inner, { blobDir, thresholdBytes: 40 });
    const largeLiteral = `"${'x'.repeat(80)}"^^<http://www.w3.org/2001/XMLSchema#string>`;
    const smallLiteral = '"small literal"';
    const largeNonSwmLiteral = `"${'y'.repeat(80)}"`;

    await store.insert([
      quad('http://ex.org/large', largeLiteral, SWM_GRAPH),
      quad('http://ex.org/small', smallLiteral, SWM_GRAPH),
      quad('http://ex.org/non-swm', largeNonSwmLiteral, NON_SWM_GRAPH),
      {
        subject: 'http://ex.org/iri',
        predicate: 'http://schema.org/url',
        object: 'http://ex.org/not-a-literal',
        graph: SWM_GRAPH,
      },
    ]);

    const hash = sha256Term(largeLiteral);
    expect(await readFile(blobPath(blobDir, hash), 'utf8')).toBe(largeLiteral);

    const raw = await inner.query(
      `SELECT ?s ?o WHERE { GRAPH <${SWM_GRAPH}> { ?s <http://schema.org/value> ?o } }`,
    );
    expect(raw.type).toBe('bindings');
    if (raw.type === 'bindings') {
      expect(raw.bindings).toContainEqual({
        s: 'http://ex.org/large',
        o: externalRef(hash),
      });
      expect(raw.bindings).toContainEqual({
        s: 'http://ex.org/small',
        o: smallLiteral,
      });
    }

    const select = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${SWM_GRAPH}> { ?s <http://schema.org/value> ?o } }`,
    );
    expect(select.type).toBe('bindings');
    if (select.type === 'bindings') {
      expect(select.bindings).toContainEqual({
        s: 'http://ex.org/large',
        o: largeLiteral,
      });
      expect(select.bindings).toContainEqual({
        s: 'http://ex.org/small',
        o: smallLiteral,
      });
    }

    const construct = await store.query(
      `CONSTRUCT { ?s <http://schema.org/value> ?o } WHERE { GRAPH <${SWM_GRAPH}> { ?s <http://schema.org/value> ?o } }`,
    );
    expect(construct.type).toBe('quads');
    if (construct.type === 'quads') {
      expect(construct.quads).toContainEqual(quad('http://ex.org/large', largeLiteral, ''));
      expect(construct.quads).toContainEqual(quad('http://ex.org/small', smallLiteral, ''));
    }

    const nonSwm = await inner.query(
      `SELECT ?o WHERE { GRAPH <${NON_SWM_GRAPH}> { <http://ex.org/non-swm> <http://schema.org/value> ?o } }`,
    );
    expect(nonSwm.type).toBe('bindings');
    if (nonSwm.type === 'bindings') {
      expect(nonSwm.bindings[0].o).toBe(largeNonSwmLiteral);
    }
  });

  it('forwards query options to original and rewritten literal queries', async () => {
    const blobDir = await tempBlobDir();
    const seenOptions: Array<QueryOptions | undefined> = [];
    const inner = {
      query: async (_sparql: string, options?: QueryOptions): Promise<QueryResult> => {
        seenOptions.push(options);
        return { type: 'bindings', bindings: [] };
      },
    } as unknown as TripleStore;
    const store = new SharedMemoryLiteralBlobStore(inner, { blobDir, thresholdBytes: 10 });
    const signalController = new AbortController();
    const largeLiteral = `"${'option-forward'.repeat(8)}"`;

    await store.query(
      `SELECT ?s WHERE { GRAPH <${SWM_GRAPH}> { ?s <http://schema.org/value> ${largeLiteral} } }`,
      { signal: signalController.signal },
    );

    expect(seenOptions).toHaveLength(2);
    expect(seenOptions.every((options) => options?.signal === signalController.signal)).toBe(true);
  });

  it('matches exact large literal constants through SELECT, ASK, and FILTER equality', async () => {
    const blobDir = await tempBlobDir();
    const store = new SharedMemoryLiteralBlobStore(new OxigraphStore(), { blobDir, thresholdBytes: 20 });
    const largeLiteral = `"${'exact-match'.repeat(8)}"`;
    const q = quad('http://ex.org/exact', largeLiteral, SWM_GRAPH);

    await store.insert([q]);

    const select = await store.query(
      `SELECT ?s WHERE { GRAPH <${SWM_GRAPH}> { ?s <http://schema.org/value> ${largeLiteral} } }`,
    );
    expect(select.type).toBe('bindings');
    if (select.type === 'bindings') {
      expect(select.bindings).toEqual([{ s: q.subject }]);
    }

    const ask = await store.query(
      `ASK WHERE { GRAPH <${SWM_GRAPH}> { <${q.subject}> <http://schema.org/value> ${largeLiteral} } }`,
    );
    expect(ask).toEqual({ type: 'boolean', value: true });

    const filtered = await store.query(
      `SELECT ?o WHERE {
        GRAPH <${SWM_GRAPH}> {
          <${q.subject}> <http://schema.org/value> ?o .
          FILTER(?o = ${largeLiteral})
        }
      }`,
    );
    expect(filtered.type).toBe('bindings');
    if (filtered.type === 'bindings') {
      expect(filtered.bindings).toEqual([{ o: largeLiteral }]);
    }
  });

  it('translates deletes passed with the original large literal term', async () => {
    const blobDir = await tempBlobDir();
    const inner = new OxigraphStore();
    const store = new SharedMemoryLiteralBlobStore(inner, { blobDir, thresholdBytes: 20 });
    const largeLiteral = `"${'delete-me'.repeat(8)}"`;
    const q = quad('http://ex.org/delete', largeLiteral, SWM_GRAPH);

    await store.insert([q]);
    expect(await inner.countQuads(SWM_GRAPH)).toBe(1);

    await store.delete([q]);
    expect(await inner.countQuads(SWM_GRAPH)).toBe(0);
  });

  it('translates deleteByPattern object filters passed with the original large literal term', async () => {
    const blobDir = await tempBlobDir();
    const inner = new OxigraphStore();
    const store = new SharedMemoryLiteralBlobStore(inner, { blobDir, thresholdBytes: 20 });
    const largeLiteral = `"${'pattern-delete'.repeat(8)}"`;

    await store.insert([
      quad('http://ex.org/delete-1', largeLiteral, SWM_GRAPH),
      quad('http://ex.org/delete-2', largeLiteral, SWM_GRAPH),
    ]);

    const removed = await store.deleteByPattern({ object: largeLiteral, graph: SWM_GRAPH });
    expect(removed).toBe(2);
    expect(await inner.countQuads(SWM_GRAPH)).toBe(0);
  });

  it('fails loudly when hydrating a missing or corrupt blob', async () => {
    const blobDir = await tempBlobDir();
    const store = new SharedMemoryLiteralBlobStore(new OxigraphStore(), { blobDir, thresholdBytes: 20 });
    const largeLiteral = `"${'hydrate-me'.repeat(8)}"`;
    const hash = sha256Term(largeLiteral);

    await store.insert([quad('http://ex.org/corrupt', largeLiteral, SWM_GRAPH)]);
    await rm(blobPath(blobDir, hash));

    await expect(
      store.query(`SELECT ?o WHERE { GRAPH <${SWM_GRAPH}> { ?s <http://schema.org/value> ?o } }`),
    ).rejects.toThrow(/external literal blob missing/);

    await writeFile(blobPath(blobDir, hash), '"wrong"', 'utf8');
    await expect(
      store.query(`SELECT ?o WHERE { GRAPH <${SWM_GRAPH}> { ?s <http://schema.org/value> ?o } }`),
    ).rejects.toThrow(/external literal blob corrupt/);
  });

  it('verifies an existing content-addressed file before reusing it on write', async () => {
    const blobDir = await tempBlobDir();
    const store = new SharedMemoryLiteralBlobStore(new OxigraphStore(), { blobDir, thresholdBytes: 20 });
    const largeLiteral = `"${'existing-file'.repeat(8)}"`;
    const hash = sha256Term(largeLiteral);
    await mkdir(blobDir, { recursive: true });
    await writeFile(blobPath(blobDir, hash), '"wrong"', 'utf8');

    await expect(
      store.insert([quad('http://ex.org/existing', largeLiteral, SWM_GRAPH)]),
    ).rejects.toThrow(/external literal blob corrupt/);
  });

  it('preserves an ordinary insert blob after an indeterminate post-commit failure', async () => {
    const blobDir = await tempBlobDir();
    const base = new OxigraphStore();
    const inner = overrideStore(base, {
      insert: async (quads, options) => {
        await base.insert(quads, options);
        throw new Error('insert response lost after commit');
      },
    });
    const store = new SharedMemoryLiteralBlobStore(inner, { blobDir, thresholdBytes: 20 });
    const largeLiteral = `"${'indeterminate-insert'.repeat(10)}"`;
    const subject = 'http://ex.org/indeterminate-insert';

    await expect(store.insert([quad(subject, largeLiteral, SWM_GRAPH)]))
      .rejects.toThrow('insert response lost after commit');
    expect(await readFile(blobPath(blobDir, sha256Term(largeLiteral)), 'utf8')).toBe(largeLiteral);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${SWM_GRAPH}> { <${subject}> <http://schema.org/value> ?o } }`,
    );
    expect(result.type === 'bindings' ? result.bindings : []).toEqual([{ o: largeLiteral }]);
  });

  it('retains an atomic replacement blob after pre-dispatch refusal for reference-aware GC', async () => {
    const blobDir = await tempBlobDir();
    const base = new OxigraphStore();
    const inner = overrideStore(base, {
      replaceGraph: async () => {
        throw new UnsupportedTripleStoreCapabilityError('replaceGraph', 'refusing-test-store');
      },
    });
    const store = new SharedMemoryLiteralBlobStore(inner, { blobDir, thresholdBytes: 20 });
    const largeLiteral = `"${'refused-replacement'.repeat(10)}"`;

    await expect(store.replaceGraph(SWM_GRAPH, [
      quad('http://ex.org/refused-replacement', largeLiteral, SWM_GRAPH),
    ])).rejects.toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
    expect(await readdir(blobDir)).toHaveLength(1);
  });

  it('preserves a blob committed by another store instance sharing the directory', async () => {
    const blobDir = await tempBlobDir();
    let losingEnteredResolve!: () => void;
    let releaseLosingResolve!: () => void;
    const losingEntered = new Promise<void>((resolve) => { losingEnteredResolve = resolve; });
    const releaseLosing = new Promise<void>((resolve) => { releaseLosingResolve = resolve; });
    const losingInner = overrideStore(new OxigraphStore(), {
      rfc64AuthorCommitCasV1: async () => {
        losingEnteredResolve();
        await releaseLosing;
        return 'conflict';
      },
    });
    const committedBase = new OxigraphStore();
    const committedInner = overrideStore(committedBase, {
      rfc64AuthorCommitCasV1: async (input) => {
        const plan = normalizeRfc64AuthorCommitCasV1(input);
        await committedBase.insert([...plan.graphReplacements[0]!.quads]);
        return 'committed';
      },
    });
    const losingStore = new SharedMemoryLiteralBlobStore(
      losingInner,
      { blobDir, thresholdBytes: 20 },
    );
    const committedStore = new SharedMemoryLiteralBlobStore(
      committedInner,
      { blobDir, thresholdBytes: 20 },
    );
    const largeLiteral = `"${'cleanup-race'.repeat(30)}"`;
    const subject = 'http://ex.org/cleanup-race';
    const input = rfc64Input(subject, largeLiteral);

    const losingWriter = losingStore.rfc64AuthorCommitCasV1(input);
    await losingEntered;
    await expect(committedStore.rfc64AuthorCommitCasV1(input)).resolves.toBe('committed');
    releaseLosingResolve();
    await expect(losingWriter).resolves.toBe('conflict');
    expect(await readFile(blobPath(blobDir, sha256Term(largeLiteral)), 'utf8')).toBe(largeLiteral);
    const result = await committedStore.query(
      `SELECT ?o WHERE { GRAPH <${SWM_GRAPH}> { <${subject}> <http://schema.org/value> ?o } }`,
    );
    expect(result.type === 'bindings' ? result.bindings : []).toEqual([{ o: largeLiteral }]);
  });

  it('can be enabled through createTripleStore configuration', async () => {
    const blobDir = await tempBlobDir();
    const store = await createTripleStore({
      backend: 'oxigraph',
      largeLiteralStorage: { directory: blobDir, thresholdBytes: 20 },
    });
    const largeLiteral = `"${'configured'.repeat(8)}"`;

    await store.insert([quad('http://ex.org/configured', largeLiteral, SWM_GRAPH)]);

    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${SWM_GRAPH}> { <http://ex.org/configured> <http://schema.org/value> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings[0].o).toBe(largeLiteral);
    }
    await store.close();
  });

  it('reopens persisted placeholders from disk and hydrates from existing blobs', async () => {
    const dataDir = await tempBlobDir();
    const storePath = join(dataDir, 'store.nq');
    const blobDir = join(dataDir, 'literal-blobs');
    const largeLiteral = `"${'persisted'.repeat(16)}"`;

    const first = await createTripleStore({
      backend: 'oxigraph-persistent',
      options: { path: storePath },
      largeLiteralStorage: { directory: blobDir, thresholdBytes: 20 },
    });
    await first.insert([quad('http://ex.org/persisted', largeLiteral, SWM_GRAPH)]);
    await first.flush?.();
    await first.close();

    const storeNq = await readFile(storePath, 'utf8');
    const hash = sha256Term(largeLiteral);
    expect(storeNq).toContain(externalRef(hash));
    expect(storeNq).not.toContain('persistedpersistedpersisted');
    expect(await readFile(blobPath(blobDir, hash), 'utf8')).toBe(largeLiteral);

    const reopened = await createTripleStore({
      backend: 'oxigraph-persistent',
      options: { path: storePath },
      largeLiteralStorage: { directory: blobDir, thresholdBytes: 20 },
    });
    const result = await reopened.query(
      `SELECT ?o WHERE { GRAPH <${SWM_GRAPH}> { <http://ex.org/persisted> <http://schema.org/value> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings).toEqual([{ o: largeLiteral }]);
    }
    await reopened.close();
  });

  // #1863 — the atomic single-subject replace (replaceSubject) must externalize
  // oversized SWM literals like insert()/replaceGraph(), or the atomic path would
  // silently store a large literal inline and bypass blob storage.
  it('externalizes a large literal in a replaceSubject payload and hydrates the original on read', async () => {
    const blobDir = await tempBlobDir();
    const inner = new OxigraphStore();
    const store = new SharedMemoryLiteralBlobStore(inner, { blobDir, thresholdBytes: 20 });
    const subject = 'http://ex.org/subject';
    const largeLiteral = `"${'z'.repeat(80)}"`;

    // Seed a prior (small) value, then atomically replace the subject with a large one.
    await store.insert([quad(subject, '"small"', SWM_GRAPH)]);
    await store.replaceSubject(SWM_GRAPH, subject, [quad(subject, largeLiteral, SWM_GRAPH)]);

    // The large literal was externalized to a content-addressed blob; the inner
    // store holds only the ref (never the inline literal).
    const hash = sha256Term(largeLiteral);
    expect(await readFile(blobPath(blobDir, hash), 'utf8')).toBe(largeLiteral);
    const raw = await inner.query(
      `SELECT ?o WHERE { GRAPH <${SWM_GRAPH}> { <${subject}> <http://schema.org/value> ?o } }`,
    );
    expect(raw.type === 'bindings' ? raw.bindings : []).toEqual([{ o: externalRef(hash) }]);

    // The public query hydrates the ORIGINAL literal intact, and the stale small
    // value is gone (the replace was atomic, not additive).
    const select = await store.query(
      `SELECT ?o WHERE { GRAPH <${SWM_GRAPH}> { <${subject}> <http://schema.org/value> ?o } }`,
    );
    expect(select.type === 'bindings' ? select.bindings : []).toEqual([{ o: largeLiteral }]);
  });
});

function quad(subject: string, object: string, graph: string): Quad {
  return {
    subject,
    predicate: 'http://schema.org/value',
    object,
    graph,
  };
}

function sha256Term(term: string): string {
  return createHash('sha256').update(term, 'utf8').digest('hex');
}

function externalRef(hash: string): string {
  return `"sha256:${hash}"^^<${EXTERNAL_LITERAL_REF_DATATYPE}>`;
}

function blobPath(blobDir: string, hash: string): string {
  return join(blobDir, hash);
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

function rfc64Input(subject: string, object: string): Rfc64AuthorCommitCasInputV1 {
  const sealGraph = 'urn:test:blob-race:seal-graph';
  const headGraph = 'urn:test:blob-race:head-graph';
  const stateGraph = 'urn:test:blob-race:state-graph';
  const transition = (role: string) => ({
    graphUri: stateGraph,
    subject: `urn:test:blob-race:${role}`,
    predicate: 'http://schema.org/value',
    expectedObject: null,
    expectedQuads: null,
    quads: [quad(`urn:test:blob-race:${role}`, `"${role}-next"`, stateGraph)],
  });
  return {
    sharedProjectionGraph: SWM_GRAPH,
    sharedProjectionQuads: [quad(subject, object, SWM_GRAPH)],
    authorSealGraph: sealGraph,
    authorSealSubject: 'urn:test:blob-race:seal',
    authorSealQuads: [quad('urn:test:blob-race:seal', '"seal"', sealGraph)],
    currentHead: {
      graphUri: headGraph,
      subject: 'urn:test:blob-race:author',
      predicate: 'http://schema.org/value',
      expectedObject: null,
      expectedQuads: null,
      quads: [quad(
        'urn:test:blob-race:author',
        'urn:test:blob-race:head:new',
        headGraph,
      )],
    },
    subgraphMutationGeneration: transition('subgraph-generation'),
    contextGraphMutationGeneration: transition('context-graph-generation'),
    appliedSet: transition('applied-set'),
  };
}
