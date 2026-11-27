import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHANGELOG_GRAPH,
  OxigraphStore,
  UnsupportedTripleStoreCapabilityError,
  createTripleStore,
  tryReplaceSubjectAtomically,
  type Quad,
  type TripleStore,
} from '../src/index.js';

// #1863 — the async-lift publisher persists a job transition via the atomic
// tryReplaceSubjectAtomically capability. These specs pin the capability's
// contract and, crucially, that it works through the REAL production decorator
// stack (createTripleStore) — a bare-adapter test alone would pass while the
// composed store silently fell back.
const GRAPH = 'urn:dkg:publisher:control-plane';
const JOB = 'urn:dkg:publisher:lift-job:job-1';
const REQ = 'urn:dkg:publisher:lift-request:job-1';

function quad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: GRAPH };
}

describe('#1863 tryReplaceSubjectAtomically capability', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('atomically replaces one subject on the embedded adapter, leaving co-located subjects untouched', async () => {
    const store = new OxigraphStore();
    await store.insert([
      quad(JOB, 'urn:dkg:publisher:status', '"accepted"'),
      quad(JOB, 'urn:dkg:publisher:retry', '"0"'),
      quad(REQ, 'urn:dkg:publisher:kind', '"request"'),
    ]);

    // Strict single-subject payload (JOB only). The co-located REQ subject was
    // seeded separately and must be left untouched by the replace.
    const ok = await tryReplaceSubjectAtomically(store, GRAPH, JOB, [
      quad(JOB, 'urn:dkg:publisher:status', '"validated"'),
    ]);

    expect(ok).toBe(true);
    // JOB fully replaced: the stale retry row is gone, status is new.
    const jobRows = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${GRAPH}> { <${JOB}> ?p ?o } } ORDER BY ?p`,
    );
    expect(jobRows.type === 'bindings' ? jobRows.bindings : []).toEqual([
      { p: 'urn:dkg:publisher:status', o: '"validated"' },
    ]);
    // REQ untouched (never in the replace scope) and not duplicated.
    expect(await store.countQuads(GRAPH)).toBe(2);
  });

  it('returns false when unavailable and propagates genuine execution errors', async () => {
    // No replaceSubject method → caller falls back.
    const bare = {} as unknown as TripleStore;
    expect(await tryReplaceSubjectAtomically(bare, GRAPH, JOB, [])).toBe(false);

    // Clean preflight refusal (e.g. a best-effort SparqlHttpStore) returns false.
    const refusing = {
      replaceSubject: async () => {
        throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'SparqlHttpStore');
      },
    } as unknown as TripleStore;
    expect(await tryReplaceSubjectAtomically(refusing, GRAPH, JOB, [])).toBe(false);

    // A genuine execution failure is NOT swallowed as "unsupported".
    const boom = {
      replaceSubject: async () => {
        throw new Error('backend down');
      },
    } as unknown as TripleStore;
    await expect(tryReplaceSubjectAtomically(boom, GRAPH, JOB, [])).rejects.toThrow('backend down');
  });

  it('performs the replace through the full production stack and does not false-reject reserved-IRI job terms', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'replace-subject-'));
    tempDirs.push(dir);
    // Prod stack: ChangelogStore -> GraphSetIndexStore -> SharedMemoryLiteralBlobStore
    // -> OxigraphWorkerStore.
    const store = await createTripleStore({
      backend: 'oxigraph-worker',
      changelog: true,
      largeLiteralStorage: { enabled: true, directory: dir },
    });
    try {
      // The outermost decorator is the changelog store — the full stack was built.
      expect(store.constructor.name).toBe('ChangelogStore');

      await store.insert([
        quad(JOB, 'urn:dkg:publisher:status', '"accepted"'),
        quad(REQ, 'urn:dkg:publisher:kind', '"request"'),
      ]);

      // (1) make-or-break: the atomic replace is actually PERFORMED end-to-end
      // through the decorators (not a flag check), including a job term whose
      // OBJECT is the reserved changelog IRI. The old raw-update path scanned the
      // serialized SPARQL for `<urn:dkg:changelog>` and false-rejected; the
      // structured replaceSubject guards only the TARGET graph, so it is accepted.
      const ok = await tryReplaceSubjectAtomically(store, GRAPH, JOB, [
        quad(JOB, 'urn:dkg:publisher:status', '"validated"'),
        quad(JOB, 'urn:dkg:publisher:refersTo', `<${CHANGELOG_GRAPH}>`),
      ]);
      expect(ok).toBe(true);

      const status = await store.query(
        `SELECT ?o WHERE { GRAPH <${GRAPH}> { <${JOB}> <urn:dkg:publisher:status> ?o } }`,
      );
      expect(status.type === 'bindings' ? status.bindings : []).toEqual([{ o: '"validated"' }]);
      const refersTo = await store.query(
        `SELECT ?o WHERE { GRAPH <${GRAPH}> { <${JOB}> <urn:dkg:publisher:refersTo> ?o } }`,
      );
      expect(refersTo.type === 'bindings' ? refersTo.bindings : []).toEqual([{ o: CHANGELOG_GRAPH }]);

      // (2) a replace whose TARGET graph is the reserved plane is still rejected
      // structurally (not writable through the public API).
      await expect(
        tryReplaceSubjectAtomically(store, CHANGELOG_GRAPH, 'urn:x', [
          { subject: 'urn:x', predicate: 'urn:p', object: '"v"', graph: CHANGELOG_GRAPH },
        ]),
      ).rejects.toThrow(/reserved changelog plane/);
    } finally {
      await store.close();
    }
  });
});
