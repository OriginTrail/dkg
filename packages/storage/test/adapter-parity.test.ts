/**
 * Same logical TripleStore operations on Oxigraph vs BlazegraphStore (mocked HTTP)
 * so backends stay aligned on counts and delete semantics (03 §16 graph isolation).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OxigraphStore, BlazegraphStore, type Quad } from '../src/index.js';

const G = 'http://parity.test/g';
const Q1: Quad = { subject: 'http://parity.test/s1', predicate: 'http://parity.test/p', object: '"a"', graph: G };
const Q2: Quad = { subject: 'http://parity.test/s2', predicate: 'http://parity.test/p', object: '"b"', graph: G };

describe('TripleStore adapter parity (Oxigraph vs mocked Blazegraph)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('insert two quads then countQuads(graph) is 2 for both backends', async () => {
    const ox = new OxigraphStore();
    await ox.insert([Q1, Q2]);
    expect(await ox.countQuads(G)).toBe(2);
    await ox.close();

    let blazeCall = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (!body.startsWith('query=')) {
        return new Response(null, { status: 200 });
      }
      blazeCall++;
      return new Response(
        JSON.stringify({
          head: { vars: ['c'] },
          results: { bindings: [{ c: { type: 'literal', value: '2', datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const blaze = new BlazegraphStore('http://blaze.parity/sparql');
    await blaze.insert([Q1, Q2]);
    expect(await blaze.countQuads(G)).toBe(2);
    expect(blazeCall).toBeGreaterThanOrEqual(1);
  });

  it('deleteByPattern removes one quad and leaves count 1 (Oxigraph; Blazegraph mocked)', async () => {
    const ox = new OxigraphStore();
    await ox.insert([Q1, Q2]);
    const removedOx = await ox.deleteByPattern({ graph: G, subject: 'http://parity.test/s1' });
    expect(removedOx).toBe(1);
    expect(await ox.countQuads(G)).toBe(1);
    await ox.close();

    let queryCount = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (!body.startsWith('query=')) {
        return new Response(null, { status: 200 });
      }
      queryCount++;
      const c = queryCount === 1 ? '2' : '1';
      return new Response(
        JSON.stringify({
          head: { vars: ['c'] },
          results: { bindings: [{ c: { type: 'literal', value: c } }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const blaze = new BlazegraphStore('http://blaze.parity/sparql');
    await blaze.insert([Q1, Q2]);
    const removedBlaze = await blaze.deleteByPattern({ graph: G, subject: 'http://parity.test/s1' });
    expect(removedBlaze).toBe(1);
    expect(await blaze.countQuads(G)).toBe(1);
  });
});
