/**
 * BlazegraphStore unit tests with mocked fetch (03 §16 — graph isolation via GRAPH IRIs;
 * no live Blazegraph required).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';

describe('BlazegraphStore (mocked HTTP)', () => {
  const baseUrl = 'http://blaze.test/sparql';

  let fetchCalls: [input: string | URL | Request, init?: RequestInit][];
  let originalFetch: typeof globalThis.fetch;

  function setFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
    globalThis.fetch = (async (input: any, init?: any) => {
      fetchCalls.push([input, init]);
      return handler(input, init);
    }) as typeof fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    setFetch(async () => new Response(null, { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('strips trailing slash from endpoint URL', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(`${baseUrl}/`);
    await s.insert([{ subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"o"', graph: 'http://ex.org/g' }]);
    expect(fetchCalls[0][0]).toBe(baseUrl);
  });

  it('insert is a no-op for empty quad list', async () => {
    const s = new BlazegraphStore(baseUrl);
    await s.insert([]);
    expect(fetchCalls).toHaveLength(0);
  });

  it('insert POSTs N-Quads with correct content type', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.insert([
      {
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"o"',
        graph: 'http://ex.org/g',
      },
    ]);
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0];
    expect(url).toBe(baseUrl);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('text/x-nquads');
    expect(String(init?.body)).toContain('<http://ex.org/s>');
    expect(String(init?.body)).toContain('<http://ex.org/g>');
  });

  it('insert throws on HTTP error with body snippet', async () => {
    setFetch(async () => new Response('bad request', { status: 400, statusText: 'Bad Request' }));
    const s = new BlazegraphStore(baseUrl);
    await expect(
      s.insert([
        { subject: 'http://a', predicate: 'http://b', object: '"c"', graph: 'http://g' },
      ]),
    ).rejects.toThrow(/Blazegraph insert failed \(400\)/);
  });

  it('SELECT query parses JSON bindings (graph isolation query)', async () => {
    setFetch(async () => new Response(
      JSON.stringify({
        head: { vars: ['name'] },
        results: {
          bindings: [
            {
              name: { type: 'literal', value: 'Alice' },
            },
          ],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const s = new BlazegraphStore(baseUrl);
    const r = await s.query(
      'SELECT ?name WHERE { GRAPH <http://ctx/1> { ?s <http://schema.org/name> ?name } }',
    );
    expect(r.type).toBe('bindings');
    if (r.type === 'bindings') {
      expect(r.bindings).toHaveLength(1);
      expect(r.bindings[0].name).toBe('"Alice"');
    }
    const [, init] = fetchCalls[0];
    expect(String(init?.body)).toMatch(/^query=/);
  });

  it('ASK query returns boolean result', async () => {
    setFetch(async () => new Response(JSON.stringify({ boolean: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const s = new BlazegraphStore(baseUrl);
    const r = await s.query('ASK { GRAPH <http://g1> { ?s ?p ?o } }');
    expect(r.type).toBe('boolean');
    if (r.type === 'boolean') expect(r.value).toBe(true);
  });

  it('query throws when SPARQL endpoint returns error', async () => {
    setFetch(async () => new Response('syntax error', { status: 500 }));
    const s = new BlazegraphStore(baseUrl);
    await expect(s.query('SELECT * WHERE { ?s ?p ?o }')).rejects.toThrow(/Blazegraph query failed/);
  });

  it('CONSTRUCT returns quads from n-quads body', async () => {
    setFetch(async () => new Response(
      '<http://s> <http://p> "o" <http://g> .\n',
      { status: 200, headers: { 'Content-Type': 'text/x-nquads' } },
    ));
    const s = new BlazegraphStore(baseUrl);
    const r = await s.query('CONSTRUCT WHERE { ?s ?p ?o }');
    expect(r.type).toBe('quads');
    if (r.type === 'quads') {
      expect(r.quads.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('dropGraph sends SPARQL UPDATE', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.dropGraph('http://ex.org/g1');
    expect(fetchCalls.length).toBeGreaterThan(0);
    const call = fetchCalls.find((c) =>
      String(c[1]?.body).includes('DROP%20SILENT%20GRAPH'),
    );
    expect(call).toBeDefined();
  });

  it('delete is a no-op for empty quad list', async () => {
    const s = new BlazegraphStore(baseUrl);
    await s.delete([]);
    expect(fetchCalls).toHaveLength(0);
  });

  it('delete sends SPARQL UPDATE DELETE DATA', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.delete([
      { subject: 'http://s', predicate: 'http://p', object: '"o"', graph: 'http://g' },
    ]);
    const call = fetchCalls.find((c) =>
      decodeURIComponent(String(c[1]?.body)).includes('DELETE DATA'),
    );
    expect(call).toBeDefined();
  });

  it('sparql update errors surface on delete failure', async () => {
    setFetch(async () => new Response('fail', { status: 500 }));
    const s = new BlazegraphStore(baseUrl);
    await expect(
      s.delete([{ subject: 'http://a', predicate: 'http://b', object: '"c"', graph: 'http://g' }]),
    ).rejects.toThrow(/Blazegraph update failed/);
  });

  // Pre-v10-rc-merge follow-up (storage/blazegraph.ts:54-100). The old
  // single-graph `deleteByPattern` used a before/after `countQuads` delta
  // behind a `DELETE { GRAPH <g> { ... } } WHERE { ... }` template, which
  // silently no-oped on real Blazegraph 2.1.5 REST endpoints (caught by
  // `adapter-parity-extra.test.ts` against the live service in CI). The
  // adapter now materialises matching bindings via SELECT and issues one
  // `DELETE DATA` per row, mirroring the no-graph path. This test pins
  // that contract: 3 SELECT rows → 3 DELETE DATA calls → removed === 3.
  it('deleteByPattern (single graph) materialises bindings and issues one DELETE DATA per row', async () => {
    const updateBodies: string[] = [];
    setFetch(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.startsWith('update=')) {
        updateBodies.push(decodeURIComponent(body.slice('update='.length)));
        return new Response(null, { status: 200 });
      }
      if (body.startsWith('query=')) {
        return new Response(
          JSON.stringify({
            head: { vars: ['p', 'o'] },
            results: {
              bindings: [
                { p: { type: 'uri', value: 'http://ex/p1' }, o: { type: 'literal', value: 'a' } },
                { p: { type: 'uri', value: 'http://ex/p2' }, o: { type: 'literal', value: 'b' } },
                { p: { type: 'uri', value: 'http://ex/p3' }, o: { type: 'literal', value: 'c' } },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(null, { status: 200 });
    });
    const s = new BlazegraphStore(baseUrl);
    const removed = await s.deleteByPattern({ graph: 'http://g', subject: 'http://s' });
    expect(removed).toBe(3);
    expect(updateBodies).toHaveLength(3);
    for (const u of updateBodies) {
      expect(u).toMatch(/DELETE DATA \{ GRAPH <http:\/\/g> \{ <http:\/\/s> <http:\/\/ex\/p\d> "[abc]" \. \} \}/);
    }
  });

  // Regression: a SELECT that finds no matching rows must return 0 and
  // issue ZERO `DELETE DATA` calls. The previous before/after-COUNT
  // implementation could return a non-zero delta here if countQuads
  // fluctuated across the two calls for unrelated reasons.
  it('deleteByPattern (single graph) returns 0 and issues no DELETE DATA when no rows match', async () => {
    const updateBodies: string[] = [];
    setFetch(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.startsWith('update=')) {
        updateBodies.push(decodeURIComponent(body.slice('update='.length)));
        return new Response(null, { status: 200 });
      }
      if (body.startsWith('query=')) {
        return new Response(
          JSON.stringify({
            head: { vars: ['p', 'o'] },
            results: { bindings: [] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(null, { status: 200 });
    });
    const s = new BlazegraphStore(baseUrl);
    const removed = await s.deleteByPattern({ graph: 'http://g', subject: 'http://unknown' });
    expect(removed).toBe(0);
    expect(updateBodies).toHaveLength(0);
  });

  // Bot review (PR #229 follow-up, blazegraph.ts:131): the previous
  // revision blanket-skipped the default-graph delete whenever the same
  // (s,p,o) had any named-graph hit, which silently lost a real
  // default-graph row when BOTH intentionally existed. The fix runs the
  // default-dataset SELECT AFTER the named deletes and issues a DELETE
  // DATA for each remaining row. Pin that a default-graph triple is
  // deleted even when the same (s,p,o) also exists in a named graph.
  it('deleteByPattern (no graph) deletes BOTH the named-graph row AND the default-graph row for the same (s,p,o)', async () => {
    const updates: string[] = [];
    let selectCall = 0;
    setFetch(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.startsWith('update=')) {
        updates.push(decodeURIComponent(body.slice('update='.length)));
        return new Response(null, { status: 200 });
      }
      if (body.startsWith('query=')) {
        selectCall++;
        const decoded = decodeURIComponent(body.slice('query='.length));
        if (/^SELECT/i.test(decoded.trim()) && /GRAPH \?g/.test(decoded)) {
          // Named-graph SELECT: return one hit.
          return new Response(
            JSON.stringify({
              head: { vars: ['g'] },
              results: {
                bindings: [{ g: { type: 'uri', value: 'http://ex.org/named1' } }],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (/^SELECT/i.test(decoded.trim())) {
          // Default-dataset SELECT: report the triple (simulating
          // Blazegraph quads-mode's default-dataset union view). After
          // the named delete this row represents a genuine default-
          // graph instance that MUST be removed.
          return new Response(
            JSON.stringify({ head: { vars: [] }, results: { bindings: [{}] } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (/^ASK/i.test(decoded.trim())) {
          // The default-graph existence check: return TRUE so the
          // default-graph delete proceeds.
          return new Response(
            JSON.stringify({ boolean: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }
      return new Response(null, { status: 200 });
    });
    const s = new BlazegraphStore(baseUrl);
    const removed = await s.deleteByPattern({
      subject: 'http://ex.org/s',
      predicate: 'http://ex.org/p',
      object: '"o"',
    });
    // One delete for the named-graph instance, one for the default-graph
    // instance = 2 total. Previously the default-graph delete was
    // suppressed by the `namedHit` gate, returning 1.
    expect(removed).toBe(2);
    const namedDelete = updates.find((u) => u.includes('GRAPH <http://ex.org/named1>') && u.includes('DELETE DATA'));
    const defaultDelete = updates.find((u) => /DELETE DATA\s*\{\s*<http:\/\/ex\.org\/s>/.test(u) && !u.includes('GRAPH'));
    expect(namedDelete).toBeDefined();
    expect(defaultDelete).toBeDefined();
  });

  it('deleteByPattern (no graph) does NOT delete the default-graph row when the ASK probe reports it absent', async () => {
    const updates: string[] = [];
    setFetch(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.startsWith('update=')) {
        updates.push(decodeURIComponent(body.slice('update='.length)));
        return new Response(null, { status: 200 });
      }
      if (body.startsWith('query=')) {
        const decoded = decodeURIComponent(body.slice('query='.length));
        if (/^SELECT/i.test(decoded.trim()) && /GRAPH \?g/.test(decoded)) {
          return new Response(
            JSON.stringify({
              head: { vars: ['g'] },
              results: { bindings: [{ g: { type: 'uri', value: 'http://ex.org/g1' } }] },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (/^SELECT/i.test(decoded.trim())) {
          // After the named delete, the default-dataset SELECT still
          // echoes the triple (because the engine re-checked it and the
          // named row HAS been removed, so the only remaining row would
          // be the default one — EXCEPT here the ASK below will say
          // it's not there, simulating "the named row was the only
          // place it lived").
          return new Response(
            JSON.stringify({ head: { vars: [] }, results: { bindings: [{}] } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (/^ASK/i.test(decoded.trim())) {
          return new Response(
            JSON.stringify({ boolean: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }
      return new Response(null, { status: 200 });
    });
    const s = new BlazegraphStore(baseUrl);
    const removed = await s.deleteByPattern({
      subject: 'http://ex.org/s',
      predicate: 'http://ex.org/p',
      object: '"o"',
    });
    expect(removed).toBe(1);
    const defaultDelete = updates.find((u) => /DELETE DATA\s*\{\s*<http:\/\/ex\.org\/s>/.test(u) && !u.includes('GRAPH'));
    expect(defaultDelete).toBeUndefined();
  });

  // PR #229 bot review (r31-7, blazegraph.ts:94/131/164). The previous
  // revision unconditionally wrapped each materialised SELECT-row
  // subject (`sx`) as `<${escapeUri(sx)}>` before issuing the
  // `DELETE DATA`. SELECT bindings in quads mode include blank-node
  // subjects (e.g. `_:b0`), so a bnode would be re-emitted as the
  // syntactically invalid IRI `<_:b0>` — Blazegraph either errored
  // on the wire or, on lenient engines, never matched the row, and
  // the bnode-subject quad stayed pinned in storage forever.
  //
  // The fix funnels the row subject through `formatTerm`, which
  // already encodes `_:foo` blank nodes correctly. These tests pin
  // the contract for all three branches (single-graph SELECT, no-
  // graph named SELECT, no-graph default-dataset SELECT) AND for the
  // top-level `pattern.subject` itself (line 55) so a caller that
  // hands a bnode subject to `deleteByPattern` still gets it deleted.
  describe('deleteByPattern — blank-node round-trip (r31-7 regression)', () => {
    it('single-graph branch: emits `_:b0` (NOT `<_:b0>`) for materialised bnode subject', async () => {
      const updates: string[] = [];
      setFetch(async (_url, init) => {
        const body = String(init?.body ?? '');
        if (body.startsWith('update=')) {
          updates.push(decodeURIComponent(body.slice('update='.length)));
          return new Response(null, { status: 200 });
        }
        if (body.startsWith('query=')) {
          return new Response(
            JSON.stringify({
              head: { vars: ['s', 'p', 'o'] },
              results: {
                bindings: [
                  {
                    s: { type: 'bnode', value: 'b0' },
                    p: { type: 'uri', value: 'http://ex/p' },
                    o: { type: 'literal', value: 'lit' },
                  },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(null, { status: 200 });
      });
      const s = new BlazegraphStore(baseUrl);
      const removed = await s.deleteByPattern({ graph: 'http://g' });
      expect(removed).toBe(1);
      expect(updates).toHaveLength(1);
      const body = updates[0];
      // The bnode lexeme MUST appear as `_:b0`, not as `<_:b0>`.
      expect(body).toContain('_:b0 <http://ex/p>');
      expect(body).not.toContain('<_:b0>');
      expect(body).toMatch(/DELETE DATA \{ GRAPH <http:\/\/g> \{ _:b0 <http:\/\/ex\/p> "lit" \. \} \}/);
    });

    it('no-graph (named) branch: emits `_:b0` (NOT `<_:b0>`) for materialised bnode subject', async () => {
      const updates: string[] = [];
      setFetch(async (_url, init) => {
        const body = String(init?.body ?? '');
        if (body.startsWith('update=')) {
          updates.push(decodeURIComponent(body.slice('update='.length)));
          return new Response(null, { status: 200 });
        }
        if (body.startsWith('query=')) {
          const decoded = decodeURIComponent(body.slice('query='.length));
          if (/GRAPH \?g/.test(decoded)) {
            return new Response(
              JSON.stringify({
                head: { vars: ['s', 'p', 'o', 'g'] },
                results: {
                  bindings: [
                    {
                      s: { type: 'bnode', value: 'b1' },
                      p: { type: 'uri', value: 'http://ex/p' },
                      o: { type: 'literal', value: 'lit' },
                      g: { type: 'uri', value: 'http://ex.org/g' },
                    },
                  ],
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          // Default-dataset SELECT after the named delete: no rows.
          return new Response(
            JSON.stringify({ head: { vars: ['s', 'p', 'o'] }, results: { bindings: [] } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(null, { status: 200 });
      });
      const s = new BlazegraphStore(baseUrl);
      const removed = await s.deleteByPattern({});
      expect(removed).toBe(1);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toContain('_:b1 <http://ex/p>');
      expect(updates[0]).not.toContain('<_:b1>');
    });

    it('no-graph (default) branch: emits `_:b0` (NOT `<_:b0>`) when default-dataset SELECT returns a bnode subject', async () => {
      const updates: string[] = [];
      setFetch(async (_url, init) => {
        const body = String(init?.body ?? '');
        if (body.startsWith('update=')) {
          updates.push(decodeURIComponent(body.slice('update='.length)));
          return new Response(null, { status: 200 });
        }
        if (body.startsWith('query=')) {
          const decoded = decodeURIComponent(body.slice('query='.length));
          if (/^SELECT/i.test(decoded.trim()) && /GRAPH \?g/.test(decoded)) {
            // Named SELECT: nothing.
            return new Response(
              JSON.stringify({ head: { vars: ['s', 'p', 'o', 'g'] }, results: { bindings: [] } }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (/^SELECT/i.test(decoded.trim())) {
            // Default-dataset SELECT: bnode-subject hit.
            return new Response(
              JSON.stringify({
                head: { vars: ['s', 'p', 'o'] },
                results: {
                  bindings: [
                    {
                      s: { type: 'bnode', value: 'b2' },
                      p: { type: 'uri', value: 'http://ex/p' },
                      o: { type: 'literal', value: 'lit' },
                    },
                  ],
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (/^ASK/i.test(decoded.trim())) {
            return new Response(
              JSON.stringify({ boolean: true }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
        }
        return new Response(null, { status: 200 });
      });
      const s = new BlazegraphStore(baseUrl);
      const removed = await s.deleteByPattern({});
      expect(removed).toBe(1);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toContain('_:b2 <http://ex/p>');
      expect(updates[0]).not.toContain('<_:b2>');
    });

    it('top-level pattern.subject branch: caller-supplied bnode subject round-trips as `_:bX` (NOT `<_:bX>`)', async () => {
      // White-box: when the caller passes `{ subject: '_:b9' }`, the
      // SELECT triple template (`triple` at line 58) and the per-row
      // DELETE template both need to keep `_:b9` as `_:b9` instead of
      // wrapping it as the invalid IRI `<_:b9>`.
      const queriesSeen: string[] = [];
      const updates: string[] = [];
      setFetch(async (_url, init) => {
        const body = String(init?.body ?? '');
        if (body.startsWith('update=')) {
          updates.push(decodeURIComponent(body.slice('update='.length)));
          return new Response(null, { status: 200 });
        }
        if (body.startsWith('query=')) {
          const decoded = decodeURIComponent(body.slice('query='.length));
          queriesSeen.push(decoded);
          return new Response(
            JSON.stringify({
              head: { vars: ['p', 'o'] },
              results: {
                bindings: [
                  { p: { type: 'uri', value: 'http://ex/p' }, o: { type: 'literal', value: 'lit' } },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(null, { status: 200 });
      });
      const s = new BlazegraphStore(baseUrl);
      const removed = await s.deleteByPattern({ graph: 'http://g', subject: '_:b9' });
      expect(removed).toBe(1);
      // SELECT must use `_:b9` as the subject, not `<_:b9>`.
      const selectQ = queriesSeen.find((q) => /^SELECT/i.test(q.trim()));
      expect(selectQ).toBeDefined();
      expect(selectQ!).toContain('_:b9');
      expect(selectQ!).not.toContain('<_:b9>');
      // DELETE DATA must use `_:b9` as the subject, not `<_:b9>`.
      expect(updates).toHaveLength(1);
      expect(updates[0]).toContain('_:b9 <http://ex/p>');
      expect(updates[0]).not.toContain('<_:b9>');
    });
  });

  it('deleteBySubjectPrefix returns count delta', async () => {
    let call = 0;
    setFetch(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.startsWith('query=')) {
        call++;
        return new Response(
          JSON.stringify({
            head: { vars: ['c'] },
            results: { bindings: [{ c: { type: 'literal', value: call === 1 ? '10' : '4' } }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(null, { status: 200 });
    });
    const s = new BlazegraphStore(baseUrl);
    const removed = await s.deleteBySubjectPrefix('http://graph', 'http://prefix');
    expect(removed).toBe(6);
  });

  it('countQuads without graph uses UNION COUNT pattern', async () => {
    setFetch(async () => new Response(
      JSON.stringify({
        head: { vars: ['c'] },
        results: { bindings: [{ c: { type: 'literal', value: '99' } }] },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const s = new BlazegraphStore(baseUrl);
    const n = await s.countQuads();
    expect(n).toBe(99);
    const body = decodeURIComponent(String(fetchCalls[0][1]?.body));
    expect(body).toContain('UNION');
  });

  it('hasGraph uses ASK scoped to graph IRI', async () => {
    setFetch(async () => new Response(JSON.stringify({ boolean: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const s = new BlazegraphStore(baseUrl);
    expect(await s.hasGraph('http://g')).toBe(false);
  });

  it('listGraphs maps binding ?g to IRIs', async () => {
    setFetch(async () => new Response(
      JSON.stringify({
        head: { vars: ['g'] },
        results: {
          bindings: [
            { g: { type: 'uri', value: 'http://g1' } },
            { g: { type: 'uri', value: 'http://g2' } },
          ],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const s = new BlazegraphStore(baseUrl);
    const graphs = await s.listGraphs();
    expect(graphs).toEqual(['http://g1', 'http://g2']);
  });

  it('CONSTRUCT failure throws Blazegraph construct failed', async () => {
    setFetch(async () => new Response('bad', { status: 502 }));
    const s = new BlazegraphStore(baseUrl);
    await expect(s.query('CONSTRUCT WHERE { ?s ?p ?o }')).rejects.toThrow(/Blazegraph construct failed/);
  });

  it('createGraph and close are no-ops', async () => {
    const s = new BlazegraphStore(baseUrl);
    await expect(s.createGraph('http://any')).resolves.toBeUndefined();
    await expect(s.close()).resolves.toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });
});
