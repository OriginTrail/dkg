import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTERNAL_LITERAL_REF_DATATYPE,
  OxigraphStore,
  SharedMemoryLiteralBlobStore,
  createTripleStore,
  type Quad,
} from '../src/index.js';

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
