// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAssertions } from '../src/ui/api.js';

// PR #710 — pins `listAssertions`' URI parsing directly. The
// component test in `context-graph-empty-stat-components.test.ts`
// mocks `listAssertions` itself, so a regression in the parsing /
// filter logic wouldn't be caught there. This test mocks the
// underlying `fetch` (the SPARQL transport) and exercises
// `listAssertions` end-to-end against fixture bindings.
//
// Why fetch-mock rather than `vi.mock('../src/ui/api.js', …)`:
// `listAssertions` calls `executeQuery` from inside the same module,
// and ES intra-module references resolve to the local binding —
// not the mocked export. Mocking the transport boundary
// (`globalThis.fetch`, used by `post()` in api.ts) keeps the
// parser code-path under test verbatim. Same pattern as
// `use-swm-attributions.test.ts` from the prior round.

// #844 fix — WM listing now derives from the `<cg>/_meta` lifecycle graph
// (filtering on `dkg:memoryLayer "WM"`) rather than enumerating data graphs,
// because #844 gated the WM view's `GRAPH ?g` enumeration. The SPARQL applies
// the `"WM"` filter server-side, so a mocked response represents rows the
// daemon already filtered to WM; these fixtures exercise the JS mapping
// (binding → {name, graphUri, subGraph}, dedup, skip-incomplete).
//
// Binding shape mirrors the new SELECT: ?assertion (lifecycle URN, used as
// graphUri), ?name (dkg:assertionName), optional ?sg (dkg:subGraphName).
function metaRow(opts: { assertion: string; name?: string; sg?: string; assertionGraph?: string }) {
  const b: Record<string, { value: string }> = { assertion: { value: opts.assertion } };
  if (opts.name !== undefined) b.name = { value: opts.name };
  if (opts.sg !== undefined) b.sg = { value: opts.sg };
  if (opts.assertionGraph !== undefined) b.assertionGraph = { value: opts.assertionGraph };
  return b;
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as any;
}

describe('listAssertions (WM) — derives from _meta (memoryLayer="WM")', () => {
  let originalFetch: typeof globalThis.fetch | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  function setBindings(bindings: unknown[]) {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: { bindings } }),
    );
  }

  it('queries the <cg>/_meta graph filtered to memoryLayer "WM"', async () => {
    setBindings([
      metaRow({ assertion: 'urn:dkg:assertion:cg-A:0xabc:notes', name: 'notes' }),
    ]);
    await listAssertions('cg-A', 'wm');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sparql).toContain('did:dkg:context-graph:cg-A/_meta');
    expect(body.sparql).toContain('memoryLayer> "WM"');
    expect(body.sparql).toContain('assertionName');
    // assertionGraph is bound again (pre-#710 sub-graph fallback).
    expect(body.sparql).toContain('assertionGraph');
  });

  it('maps a root-bucket WM assertion: name + lifecycle-URN graphUri, subGraph undefined', async () => {
    setBindings([
      metaRow({ assertion: 'urn:dkg:assertion:cg-A:0xabc:notes', name: 'notes' }),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'notes',
      graphUri: 'urn:dkg:assertion:cg-A:0xabc:notes',
      subGraph: undefined,
    });
  });

  it('surfaces sub-graph-scoped + root rows; subGraph comes from dkg:subGraphName (#710)', async () => {
    setBindings([
      metaRow({ assertion: 'urn:dkg:assertion:cg-A:0xabc:root-doc', name: 'root-doc' }),
      metaRow({ assertion: 'urn:dkg:assertion:cg-A:research:0xabc:scoped-doc', name: 'scoped-doc', sg: 'research' }),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(2);
    const root = out.find(a => a.name === 'root-doc')!;
    const scoped = out.find(a => a.name === 'scoped-doc')!;
    expect(root.subGraph).toBeUndefined();
    expect(scoped.subGraph).toBe('research');
    expect(scoped.graphUri).toBe('urn:dkg:assertion:cg-A:research:0xabc:scoped-doc');
  });

  it('pre-#710 compat: derives subGraph from the assertionGraph URI when subGraphName is absent', async () => {
    // Drafts created before #710 carry dkg:assertionGraph but NO
    // dkg:subGraphName. The sub-graph segment must be recovered from the
    // assertion-graph URI so promote/preview stay correctly scoped.
    setBindings([
      metaRow({
        assertion: 'urn:dkg:assertion:cg-A:legacy:0xabc:old-scoped',
        name: 'old-scoped',
        // no `sg` — pre-#710 row
        assertionGraph: 'did:dkg:context-graph:cg-A/legacy/assertion/0xabc/old-scoped',
      }),
      // Root-bucket legacy row (assertionGraph has no sub-graph segment) →
      // stays root, NOT misparsed.
      metaRow({
        assertion: 'urn:dkg:assertion:cg-A:0xabc:old-root',
        name: 'old-root',
        assertionGraph: 'did:dkg:context-graph:cg-A/assertion/0xabc/old-root',
      }),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(2);
    const scoped = out.find(a => a.name === 'old-scoped')!;
    const root = out.find(a => a.name === 'old-root')!;
    expect(scoped.subGraph).toBe('legacy');
    expect(root.subGraph).toBeUndefined();
  });

  it('prefers the explicit subGraphName literal over the assertionGraph URI parse', async () => {
    // When both are present, the literal wins (it is authoritative and the
    // URI parse is only the migration fallback).
    setBindings([
      metaRow({
        assertion: 'urn:dkg:assertion:cg-A:research:0xabc:both',
        name: 'both',
        sg: 'research',
        assertionGraph: 'did:dkg:context-graph:cg-A/research/assertion/0xabc/both',
      }),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out[0].subGraph).toBe('research');
  });

  it('skips bindings missing the lifecycle URN or the name', async () => {
    setBindings([
      metaRow({ assertion: 'urn:dkg:assertion:cg-A:0xabc:real', name: 'real' }),
      metaRow({ assertion: 'urn:dkg:assertion:cg-A:0xabc:noname' }), // no ?name → skipped
      { name: { value: 'orphan' } } as any,                          // no ?assertion → skipped
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('real');
  });

  it('dedups repeated lifecycle URNs (e.g. multiple events for one assertion) to the first', async () => {
    setBindings([
      metaRow({ assertion: 'urn:dkg:assertion:cg-A:0xabc:dup', name: 'dup' }),
      metaRow({ assertion: 'urn:dkg:assertion:cg-A:0xabc:dup', name: 'dup' }),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('dup');
  });

  it('does NOT set tripleCount (renderer guards tripleCount != null; mirrors SWM)', async () => {
    setBindings([
      metaRow({ assertion: 'urn:dkg:assertion:cg-A:0xabc:notes', name: 'notes' }),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out[0].tripleCount).toBeUndefined();
  });

  it('returns an empty list when _meta has no WM assertions', async () => {
    setBindings([]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toEqual([]);
  });
});
