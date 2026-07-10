import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '../src/adapters/oxigraph.js';

/**
 * Regression for the sync-responder O(store) fix (listGraphs enumeration).
 *
 * listGraphs() now enumerates via oxigraph's graph index —
 *   `SELECT ?g WHERE { GRAPH ?g {} FILTER EXISTS { GRAPH ?g { ?s ?p ?o } } }`
 * — instead of the O(#quads) scan `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }`.
 *
 * The FILTER EXISTS is load-bearing: a graph emptied by DELETE (not DROP) stays
 * REGISTERED in oxigraph, so a bare `GRAPH ?g {}` would over-list it and break
 * graph-set-index-store's non-empty-only contract (graph-set-index-store.ts:48-53).
 * This test fails if the query regresses to bare `GRAPH ?g {}`, and asserts the
 * enumeration still matches the historical non-empty-only semantics.
 */
describe('OxigraphStore.listGraphs — non-empty-only contract (O(store) fix)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oxigraph-listgraphs-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('lists only graphs that currently hold quads; excludes emptied-but-registered graphs', async () => {
    const store = new OxigraphStore(join(dir, 'store.nq'));
    try {
      await store.update(
        'INSERT DATA { '
        + 'GRAPH <urn:g:keep> { <urn:s1> <urn:p> <urn:o1> } '
        + 'GRAPH <urn:g:emptied> { <urn:s2> <urn:p> <urn:o2> } }',
      );
      expect((await store.listGraphs()).sort()).toEqual(['urn:g:emptied', 'urn:g:keep']);

      // Empty one graph via DELETE (NOT dropGraph) — oxigraph keeps it registered.
      await store.update('DELETE WHERE { GRAPH <urn:g:emptied> { ?s ?p ?o } }');

      // The emptied graph must be gone from the listing (non-empty-only contract).
      // Bare `GRAPH ?g {}` would still return it here → this assertion guards that.
      expect(await store.listGraphs()).toEqual(['urn:g:keep']);
    } finally {
      await store.close();
    }
  });
});
