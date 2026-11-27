/**
 * Oxigraph oversize-literal parity (OT-RFC-56 §4.6).
 *
 * Oxigraph itself accepts literals of any size, which made oxigraph-backed
 * nodes store + re-serve oversized literals that Blazegraph peers can
 * physically never hold — the split-brain half of the 2026-07-08 mainnet
 * poison incident. The adapter now asserts the same Java MUTF-8 hard limit
 * as the Blazegraph adapter, EXCEPT for `_shared_memory` graphs, whose
 * large literals are legitimately handled by the SharedMemoryLiteralBlobStore
 * wrapper (externalize-on-insert / rehydrate-on-query) with this adapter as
 * its inner store.
 */

import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import type { Quad } from '../src/triple-store.js';

const oversized = `"${'x'.repeat(70_000)}"`;
const q = (object: string, graph = 'http://ex.org/g', subject = 'http://ex.org/s'): Quad =>
  ({ subject, predicate: 'http://ex.org/p', object, graph }) as Quad;

describe('OxigraphStore.insert oversize parity', () => {
  it('rejects a >65,535-byte literal with OVERSIZED_RDF_LITERAL, storing nothing', async () => {
    const s = new OxigraphStore();
    await expect(s.insert([q('"small"'), q(oversized, 'http://ex.org/g', 'http://ex.org/s2')]))
      .rejects.toMatchObject({ code: 'OVERSIZED_RDF_LITERAL' });
    const r = await s.query('SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }');
    expect(r.type === 'bindings' && r.bindings).toHaveLength(0); // assert precedes load — nothing partial
  });

  it('still accepts oversized literals in _shared_memory DATA graphs (bucket + per-KA — blob-store inner-store flow)', async () => {
    const s = new OxigraphStore();
    await s.insert([
      q(oversized, 'http://ex.org/cg/_shared_memory'),           // bucket
      q(oversized, 'http://ex.org/cg/_shared_memory/0xa/7', 'http://ex.org/s3'), // per-KA
    ]);
    const r = await s.query('SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }');
    expect(r.type === 'bindings' && r.bindings).toHaveLength(2);
  });

  it('REJECTS oversized literals in _shared_memory_meta (sibling segment, not blob-externalized)', async () => {
    const s = new OxigraphStore();
    await expect(s.insert([q(oversized, 'http://ex.org/cg/_shared_memory_meta')]))
      .rejects.toMatchObject({ code: 'OVERSIZED_RDF_LITERAL' });
  });

  it('accepts large-but-legal literals everywhere (25KB)', async () => {
    const s = new OxigraphStore();
    await s.insert([q(`"${'y'.repeat(25_000)}"`)]);
    const r = await s.query('SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }');
    expect(r.type === 'bindings' && r.bindings).toHaveLength(1);
  });
});
