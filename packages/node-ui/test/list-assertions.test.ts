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

function bRow(g: string, cnt: number) {
  // Daemon's SPARQL JSON-binding shape: object with `value`.
  return { g: { value: g }, cnt: { value: String(cnt) } };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as any;
}

describe('listAssertions (WM) — URI parse + cg-scoped filter', () => {
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
    // `listAssertions(wm)` now issues two scoped queries in parallel
    // (membership from `<cg>/_meta`, then a top-level `GRAPH ?g` triple
    // count) instead of one OPTIONAL-nested query — the latter tripped
    // the scoped-graph-variable guard (PR #749). Feed the same fixture
    // rows to both: the membership query reads `?g`, the count query
    // reads `?g` + `?cnt`, and the parser merges counts back by graph
    // URI. Order matches the Promise.all array: call[0] = membership,
    // call[1] = count.
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { bindings } }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { bindings } }));
  }

  it('parses root-bucket assertion: name extracted, subGraph undefined', async () => {
    setBindings([
      bRow('did:dkg:context-graph:cg-A/assertion/0xabc/notes', 5),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'notes',
      graphUri: 'did:dkg:context-graph:cg-A/assertion/0xabc/notes',
      tripleCount: 5,
      subGraph: undefined,
    });
  });

  it('parses sub-graph-scoped + root in the same response (#706 regression guard)', async () => {
    // Both shapes must surface. Pre-fix, the `startsWith(…/assertion/)`
    // filter silently dropped sub-graph rows entirely; this test
    // pins that they're surfaced AND that the slug + name parse out.
    setBindings([
      bRow('did:dkg:context-graph:cg-A/assertion/0xabc/root-doc', 3),
      bRow('did:dkg:context-graph:cg-A/research/assertion/0xabc/scoped-doc', 7),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(2);
    const root = out.find(a => a.name === 'root-doc')!;
    const scoped = out.find(a => a.name === 'scoped-doc')!;
    expect(root.subGraph).toBeUndefined();
    expect(scoped.subGraph).toBe('research');
    expect(scoped.tripleCount).toBe(7);
  });

  it('silently drops malformed graph URIs that lack `/assertion/`', async () => {
    // E.g. internal meta graphs, prefix-only matches, or any future
    // graph layout that shares the CG prefix but isn't an assertion.
    setBindings([
      bRow('did:dkg:context-graph:cg-A/_meta', 12),
      bRow('did:dkg:context-graph:cg-A/research', 1),
      bRow('did:dkg:context-graph:cg-A/assertion/0xabc/real', 4),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('real');
  });

  it('scopes by cgPrefix — only the queried cgId surfaces', async () => {
    // Multi-CG responses can arise if the SPARQL is run against a
    // wider store. The `startsWith(cgPrefix)` filter must reject
    // bindings from other CGs. Note: the prefix is
    // `did:dkg:context-graph:cg-A/` (trailing slash); a CG named
    // `cg-A-suffix` has prefix `…cg-A-suffix/` which does NOT
    // startsWith the queried prefix.
    setBindings([
      bRow('did:dkg:context-graph:cg-OTHER/assertion/0xabc/other', 2),
      bRow('did:dkg:context-graph:cg-A/assertion/0xabc/mine', 6),
      bRow('did:dkg:context-graph:cg-A-suffix/assertion/0xabc/foo', 1),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('mine');
  });

  it('returns an empty list when no bindings match the cg-prefix + /assertion/ filter', async () => {
    setBindings([
      bRow('did:dkg:context-graph:cg-B/assertion/0xabc/foo', 1),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toEqual([]);
  });

  it('drops bindings with 3+ segments before `assertion/` (left-side strict shape)', async () => {
    // Reviewer-flagged case: a binding like `<cg>/foo/bar/assertion/<a>/<n>`
    // doesn't match either accepted shape (root = 3 segs, sub-graph =
    // 4 segs). The prior `indexOf('/assertion/')` branch admitted it
    // as a `subGraph: undefined` row with a mis-derived name —
    // promote/preview lookups would silently miss. Strict-shape parse
    // drops it.
    setBindings([
      bRow('did:dkg:context-graph:cg-A/foo/bar/assertion/0xabc/baz', 9),
      bRow('did:dkg:context-graph:cg-A/assertion/0xabc/keep', 1),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('keep');
  });

  it('drops bindings with extra segments after the name (right-side strict shape)', async () => {
    // Pins the right-side strict-shape contract. The sub-graph branch
    // expects exactly `<sg>/assertion/<agent>/<name>` — anything
    // longer would mis-extract the name and orphan the row from
    // promote/preview.
    setBindings([
      bRow('did:dkg:context-graph:cg-A/sg/assertion/0xabc/foo/extra', 2),
      bRow('did:dkg:context-graph:cg-A/sg/assertion/0xabc/clean', 3),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'clean',
      subGraph: 'sg',
      tripleCount: 3,
    });
  });

  it('opts into includeContextGraphPartitions so assertion partitions show up (#864 rc.12 follow-up)', async () => {
    // Without this flag, `DKGQueryEngine.query` constrains `GRAPH ?g`
    // expansion to the static `{<cg>, <cg>/_meta, <cg>/_shared_memory_meta}`
    // allow-list, hiding every assertion data partition. The
    // bulk-promote button then sees an empty assertion list, iterates
    // zero times, and falls into the rc.12 "0 triples promoted" no-op
    // branch even when WM clearly contains data. Pin the request body
    // here so any future refactor that drops the opt-in fails this
    // test instead of silently re-breaking promote-all.
    setBindings([
      bRow('did:dkg:context-graph:cg-A/assertion/0xabc/notes', 5),
    ]);
    await listAssertions('cg-A', 'wm');
    // Two scoped queries now: membership (call[0]) + triple count
    // (call[1]). Both must keep the partition opt-in so `GRAPH ?g`
    // expansion reaches the assertion data partitions.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const [url, init] = call as [string, RequestInit];
      expect(String(url)).toContain('/api/query');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        contextGraphId: 'cg-A',
        includeContextGraphPartitions: true,
      });
      expect(typeof body.sparql).toBe('string');
    }
  });

  it('SPARQL gates WM membership on dkg:memoryLayer "WM" in <cg>/_meta (#898 Codex)', async () => {
    // Codex review on #898 — `assertionPromote` empties the assertion
    // data graph but intentionally leaves daemon-owned `urn:dkg:file:*`
    // / `urn:dkg:extraction:*` quads behind, so a raw `GRAPH ?g { ?s ?p
    // ?o }` count keeps returning promoted assertions. Pin the new
    // gate: the SPARQL must JOIN against `<cg>/_meta` filtered on
    // `dkg:memoryLayer "WM"` so promoted assertions (flipped to "SWM"
    // by `assertionPromote`) drop out cleanly.
    setBindings([
      bRow('did:dkg:context-graph:cg-A/assertion/0xabc/notes', 5),
    ]);
    await listAssertions('cg-A', 'wm');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.sparql).toContain('did:dkg:context-graph:cg-A/_meta');
    expect(body.sparql).toContain('http://dkg.io/ontology/memoryLayer');
    expect(body.sparql).toContain('"WM"');
    // The count query (call[1]) must ALSO gate on the `_meta` WM marker —
    // counting only WM-marked partitions instead of scanning every graph
    // under the CG (SWM/VM/meta included). Pins the Codex #944 perf fix.
    const [, countInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const countBody = JSON.parse(String(countInit.body));
    expect(countBody.sparql).toContain('did:dkg:context-graph:cg-A/_meta');
    expect(countBody.sparql).toContain('http://dkg.io/ontology/memoryLayer');
    expect(countBody.sparql).toContain('"WM"');
    expect(countBody.sparql).toContain('COUNT');
  });

  it('excludes the reserved meta sub-graph from the WM assertions list (Codex #944)', async () => {
    // `<cg>/meta/assertion/…` graphs are profile / query-catalog drafts — UI
    // configuration, not user knowledge — and must never reach the assertions
    // table or the bulk-promote flow even though they carry a WM lifecycle
    // marker. (The SPARQL also filters these daemon-side; this pins the
    // parser-level defense.)
    setBindings([
      bRow('did:dkg:context-graph:cg-A/meta/assertion/0xabc/profile', 8),
      bRow('did:dkg:context-graph:cg-A/assertion/0xabc/notes', 5),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('notes');
  });

  it('SPARQL excludes the meta namespace by path shape in both queries (Codex #944)', async () => {
    setBindings([bRow('did:dkg:context-graph:cg-A/assertion/0xabc/notes', 5)]);
    await listAssertions('cg-A', 'wm');
    const [, listInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, countInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    // Path-shape match, not a `/_meta` suffix (which would drop assertions
    // named `_meta`).
    expect(JSON.parse(String(listInit.body)).sparql).toContain('!CONTAINS(STR(?g), "/meta/assertion/")');
    expect(JSON.parse(String(countInit.body)).sparql).toContain('!CONTAINS(STR(?g), "/meta/assertion/")');
    expect(JSON.parse(String(listInit.body)).sparql).not.toContain('STRENDS(STR(?g), "/_meta")');
  });

  it('keeps a WM assertion whose name is "_meta" (Codex #944 — no /_meta suffix match)', async () => {
    // Assertion names may start with `_`, so `<cg>/assertion/<addr>/_meta` is a
    // valid root WM assertion. The reserved-meta exclusion must be by sub-graph
    // shape, not a `/_meta` suffix, or this draft becomes impossible to promote.
    setBindings([
      bRow('did:dkg:context-graph:cg-A/assertion/0xabc/_meta', 2),
    ]);
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: '_meta', subGraph: undefined });
  });

  it('still lists WM assertions when the (best-effort) count query fails', async () => {
    // Codex #944 — the triple-count query feeds only the badge, so a count
    // failure must NOT drop the whole WM list and regress promote to "no
    // assertions". The membership query (call[0]) resolves; the count query
    // (call[1]) rejects. Rows must still surface, with tripleCount undefined.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: { bindings: [bRow('did:dkg:context-graph:cg-A/assertion/0xabc/notes', 5)] } }),
    );
    fetchMock.mockRejectedValueOnce(new Error('count query timed out'));
    const out = await listAssertions('cg-A', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'notes', tripleCount: undefined });
  });

  it('scopes the /assertion/ discriminator to the tail when cgId itself contains "/assertion/"', async () => {
    // PR #710 reviewer guard — `validateContextGraphId` permits
    // slashes, so a cgId can literally contain `/assertion/` as a
    // substring. The prior `g.indexOf('/assertion/')` (full URI)
    // would have hit the cgId's internal `/assertion/` and
    // mis-sliced the name. After tail-scoping the parse, the cgId
    // is treated as opaque and only the tail's `/assertion/`
    // delimiter is consulted.
    setBindings([
      bRow('did:dkg:context-graph:weird/assertion/cg/assertion/0xabc/foo', 4),
    ]);
    const out = await listAssertions('weird/assertion/cg', 'wm');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'foo',
      subGraph: undefined,
      tripleCount: 4,
    });
  });
});
