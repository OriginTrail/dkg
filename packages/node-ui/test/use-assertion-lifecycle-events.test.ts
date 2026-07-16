// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  buildLifecycleEventsQuery,
  useAssertionLifecycleEvents,
  type AssertionLifecycleEventsResult,
} from '../src/ui/hooks/useAssertionLifecycleEvents.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('buildLifecycleEventsQuery — SPARQL shape', () => {
  // N6 polish (task #23) — pin the load-bearing parts of the query
  // so a refactor can't silently break the agent-DID-keyed activity
  // feed source.
  it('SELECTs the lifecycle binding set keyed by event + assertion + agent + ts + entityCount', () => {
    const q = buildLifecycleEventsQuery('cg-1');
    // PR #771 (Task #18) — project `dkg:subGraphName` directly from
    // the assertion subject (post-#770 canonical predicate).
    // PR #839 sweep 1 — ALSO project `dkg:assertionGraph` so the
    // reader can fall back to URI parsing for pre-#770 scoped
    // lifecycle events that exist in users' local `_meta` graphs.
    // Both OPTIONAL; literal preferred by the reader, URI parse as
    // legacy fallback.
    expect(q).toContain('SELECT ?event ?type ?assertion ?name ?agent ?ts ?subGraphName ?assertionGraph');
    // RFC ka-metadata-trim Phase 2 — read-both entity counting: DISTINCT
    // event-side rows (old stores) + the stable subject-side member stamp
    // (new shape); the reader prefers the event-side count when > 0.
    expect(q).toContain('(COUNT(DISTINCT ?root) AS ?entityCount)');
    expect(q).toContain('(COUNT(DISTINCT ?subjRoot) AS ?subjectEntityCount)');
    expect(q).toContain('OPTIONAL { ?event dkg:rootEntity ?root }');
    expect(q).toContain('OPTIONAL { ?assertion dkg:rootEntity ?subjRoot }');
    expect(q).toContain('OPTIONAL { ?assertion dkg:subGraphName ?subGraphName }');
    expect(q).toContain('OPTIONAL { ?assertion dkg:assertionGraph ?assertionGraph }');
  });

  it('RFC ka-metadata-trim Phase 2 — agent binding reads wasAssociatedWith (legacy) with subject wasAttributedTo fallback', () => {
    const q = buildLifecycleEventsQuery('cg-1');
    expect(q).toContain('OPTIONAL { ?event prov:wasAssociatedWith ?agentAssoc }');
    expect(q).toContain('OPTIONAL { ?assertion prov:wasAttributedTo ?agentAttr }');
    expect(q).toContain('BIND(COALESCE(?agentAssoc, ?agentAttr) AS ?agent)');
    // The old mandatory pattern must not come back — new events carry no
    // prov:wasAssociatedWith row and would vanish from the feed.
    expect(q).not.toContain('prov:wasAssociatedWith ?agent .');
  });

  it('COALESCEs created→`prov:generated` and promoted→`prov:used` (with a single outer type filter)', () => {
    const q = buildLifecycleEventsQuery('cg-1');
    // Both predicates are projected as OPTIONAL → COALESCE; the type
    // filter is applied ONCE on the outer pattern, not inside per-branch
    // UNION clauses. The prior UNION-with-inner-FILTER shape silently
    // returned zero rows against oxigraph in production (the filter on
    // ?type didn't interact with the outer multi-rdf:type binding) —
    // this guard locks the working shape.
    expect(q).toContain('OPTIONAL { ?event prov:generated ?gen }');
    expect(q).toContain('OPTIONAL { ?event prov:used ?used }');
    expect(q).toContain('BIND(COALESCE(?gen, ?used) AS ?assertion)');
    expect(q).toContain('FILTER(?type IN (dkg:AssertionCreated, dkg:AssertionPromoted))');
    // Regression guard: the broken UNION-with-inner-FILTER pattern
    // must not come back.
    expect(q).not.toContain('FILTER(?type = dkg:AssertionCreated)');
    expect(q).not.toContain('FILTER(?type = dkg:AssertionPromoted)');
    expect(q).not.toMatch(/UNION\s*\{/);
  });

  it('scopes the query to the project `_meta` graph for the given context graph id', () => {
    const q = buildLifecycleEventsQuery('cg-42');
    expect(q).toContain('GRAPH <did:dkg:context-graph:cg-42/_meta>');
  });

  it('groups by all non-aggregated bindings and orders by ?ts DESC with LIMIT 5000', () => {
    const q = buildLifecycleEventsQuery('cg-1');
    expect(q).toContain('GROUP BY ?event ?type ?assertion ?name ?agent ?ts ?subGraphName ?assertionGraph');
    expect(q).toContain('ORDER BY DESC(?ts)');
    expect(q).toContain('LIMIT 5000');
  });
});

describe('useAssertionLifecycleEvents — bindings parse', () => {
  let root: Root;
  let container: HTMLDivElement;
  let originalFetch: typeof globalThis.fetch | undefined;
  let pending: Map<string, { resolve: (rows: any[]) => void }>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    pending = new Map();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const cgId: string = body.contextGraphId;
      const p = new Promise<any[]>((resolve) => {
        pending.set(cgId, { resolve });
      });
      const rows = await p;
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { bindings: rows } }),
      } as any;
    }) as any;
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  async function flush() {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  function row(opts: {
    event: string;
    kind: 'created' | 'promoted';
    assertion: string;
    name: string;
    agent: string;
    ts: string;
    // PR #771 (Task #18) — `subGraphName` is the post-#770 string
    // literal binding the hook prefers.
    subGraphName?: string;
    // PR #839 sweep 1 — `assertionGraph` is the pre-#770 URI binding
    // the hook falls back to when `subGraphName` is absent. Tests
    // can populate both (post-#770 row), only assertionGraph (pre-
    // #770 legacy row), or neither (root-bucket / sparse-meta row).
    assertionGraph?: string;
    entityCount?: number;
  }) {
    const typeUri = opts.kind === 'created'
      ? 'http://dkg.io/ontology/AssertionCreated'
      : 'http://dkg.io/ontology/AssertionPromoted';
    return {
      event: `"${opts.event}"`,
      type: `"${typeUri}"`,
      assertion: `"${opts.assertion}"`,
      name: `"${opts.name}"`,
      agent: `"${opts.agent}"`,
      ts: `"${opts.ts}"`,
      subGraphName: opts.subGraphName ? `"${opts.subGraphName}"` : undefined,
      assertionGraph: opts.assertionGraph ? `"${opts.assertionGraph}"` : undefined,
      entityCount: opts.entityCount !== undefined
        ? `"${opts.entityCount}"^^<http://www.w3.org/2001/XMLSchema#integer>`
        : undefined,
    };
  }

  it('discriminates created vs promoted via rdf:type and exposes both kinds in one stream', async () => {
    let latest: AssertionLifecycleEventsResult | null = null;
    function Probe({ id }: { id: string }) {
      latest = useAssertionLifecycleEvents(id);
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-A' }));
    });
    await flush();
    pending.get('cg-A')!.resolve([
      row({
        event: 'urn:evt:create-1', kind: 'created',
        assertion: 'urn:assert:doc-1', name: 'doc-1',
        agent: 'did:dkg:agent:alice', ts: '2026-05-20T10:00:00Z',
        // created events GROUP-BY counts to 0 (no dkg:rootEntity triples).
        entityCount: 0,
      }),
      row({
        event: 'urn:evt:promote-1', kind: 'promoted',
        assertion: 'urn:assert:doc-1', name: 'doc-1',
        agent: 'did:dkg:agent:bob', ts: '2026-05-22T10:00:00Z',
        entityCount: 5,
      }),
    ]);
    await flush();
    expect(latest!.events).toHaveLength(2);
    const byKind = new Map(latest!.events.map(e => [e.kind, e]));
    expect(byKind.get('created')?.assertionName).toBe('doc-1');
    expect(byKind.get('created')?.agentUri).toBe('did:dkg:agent:alice');
    expect(byKind.get('promoted')?.agentUri).toBe('did:dkg:agent:bob');
  });

  it('populates entityCount on promoted rows; leaves it undefined on created rows', async () => {
    let latest: AssertionLifecycleEventsResult | null = null;
    function Probe({ id }: { id: string }) {
      latest = useAssertionLifecycleEvents(id);
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-A' }));
    });
    await flush();
    pending.get('cg-A')!.resolve([
      // Created with a 0 count from GROUP BY — should still surface
      // as `undefined`, not `0`, so the renderer can branch cleanly
      // ("hide" vs "show 0 entities").
      row({
        event: 'urn:evt:create-1', kind: 'created',
        assertion: 'urn:assert:doc-1', name: 'doc-1',
        agent: 'did:dkg:agent:alice', ts: '2026-05-20T10:00:00Z',
        entityCount: 0,
      }),
      // Promoted with a real bundle count.
      row({
        event: 'urn:evt:promote-1', kind: 'promoted',
        assertion: 'urn:assert:doc-1', name: 'doc-1',
        agent: 'did:dkg:agent:bob', ts: '2026-05-22T10:00:00Z',
        entityCount: 12,
      }),
    ]);
    await flush();
    const created = latest!.events.find(e => e.kind === 'created');
    const promoted = latest!.events.find(e => e.kind === 'promoted');
    expect(created?.entityCount).toBeUndefined();
    expect(promoted?.entityCount).toBe(12);
  });

  // PR #839 sweep 1 — `subGraph` derivation across the historical
  // shapes the daemon ships. The hook prefers `dkg:subGraphName`
  // (post-#770 canonical predicate) and falls back to URI parsing
  // `dkg:assertionGraph` (pre-#770 legacy migration-safety) so
  // scoped lifecycle events created before PR #770 still surface
  // their sub-graph chip on the activity feed.

  // Test 1 — Pre-#770 SCOPED assertion: only `assertionGraph` is
  // present. URI parse recovers the slug. This is the load-bearing
  // migration-safety property the Codex sweep 1 fix protects.
  it('falls back to URI parsing for pre-#770 scoped assertions missing `dkg:subGraphName`', async () => {
    let latest: AssertionLifecycleEventsResult | null = null;
    function Probe({ id }: { id: string }) {
      latest = useAssertionLifecycleEvents(id);
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-A' }));
    });
    await flush();
    pending.get('cg-A')!.resolve([
      row({
        event: 'urn:evt:legacy-scoped', kind: 'created',
        assertion: 'urn:assert:legacy-scoped', name: 'scoped-doc',
        agent: 'did:dkg:agent:alice', ts: '2026-05-20T10:00:00Z',
        // Pre-#770 writer emitted `dkg:assertionGraph` but never
        // `dkg:subGraphName`. The URI shape mirrors
        // `contextGraphAssertionUri` — sub-graph slug as first
        // path segment after the cgId.
        assertionGraph: 'did:dkg:context-graph:cg-A/research/assertion/0xabc/scoped-doc',
      }),
    ]);
    await flush();
    const evt = latest!.events.find(e => e.assertionUri === 'urn:assert:legacy-scoped');
    expect(evt?.subGraph).toBe('research');
  });

  // Test 2 — Pre-#770 ROOT-bucket assertion: only `assertionGraph`
  // is present, URI has no sub-graph segment. URI parser returns
  // undefined (correctly; no slug). Row admits chip-less.
  it('treats pre-#770 root-bucket assertions as chip-less (URI parser returns undefined)', async () => {
    let latest: AssertionLifecycleEventsResult | null = null;
    function Probe({ id }: { id: string }) {
      latest = useAssertionLifecycleEvents(id);
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-A' }));
    });
    await flush();
    pending.get('cg-A')!.resolve([
      row({
        event: 'urn:evt:legacy-root', kind: 'created',
        assertion: 'urn:assert:legacy-root', name: 'root-doc',
        agent: 'did:dkg:agent:alice', ts: '2026-05-20T10:00:00Z',
        // Pre-#770 root-bucket URI: no slug segment between cgId
        // and `assertion/`. Parser returns undefined.
        assertionGraph: 'did:dkg:context-graph:cg-A/assertion/0xabc/root-doc',
      }),
    ]);
    await flush();
    const evt = latest!.events.find(e => e.assertionUri === 'urn:assert:legacy-root');
    expect(evt?.subGraph).toBeUndefined();
    // Row admits, just chip-less — same shape as a sparse-meta row.
    expect(evt?.assertionName).toBe('root-doc');
  });

  // Test 3 — Post-#770 scoped assertion: BOTH predicates present.
  // Literal preferred — URI parser not consulted on this path.
  it('reads `subGraph` directly from `dkg:subGraphName` when present (post-#770 canonical predicate)', async () => {
    let latest: AssertionLifecycleEventsResult | null = null;
    function Probe({ id }: { id: string }) {
      latest = useAssertionLifecycleEvents(id);
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-A' }));
    });
    await flush();
    pending.get('cg-A')!.resolve([
      row({
        event: 'urn:evt:current-scoped', kind: 'created',
        assertion: 'urn:assert:current-scoped', name: 'scoped-doc',
        agent: 'did:dkg:agent:alice', ts: '2026-05-20T10:00:00Z',
        subGraphName: 'research',
        assertionGraph: 'did:dkg:context-graph:cg-A/research/assertion/0xabc/scoped-doc',
      }),
    ]);
    await flush();
    const evt = latest!.events.find(e => e.assertionUri === 'urn:assert:current-scoped');
    expect(evt?.subGraph).toBe('research');
  });

  // Test 4 — Defensive preference order: when BOTH bindings are
  // present and the URI's parsed slug disagrees with the literal,
  // the literal wins. Confirms the preference order isn't
  // accidentally reversed (URI parse must NOT clobber the canonical
  // predicate).
  it('prefers `dkg:subGraphName` over a conflicting URI segment (defensive precedence lock)', async () => {
    let latest: AssertionLifecycleEventsResult | null = null;
    function Probe({ id }: { id: string }) {
      latest = useAssertionLifecycleEvents(id);
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-A' }));
    });
    await flush();
    pending.get('cg-A')!.resolve([
      row({
        event: 'urn:evt:conflict', kind: 'created',
        assertion: 'urn:assert:conflict', name: 'conflict-doc',
        agent: 'did:dkg:agent:alice', ts: '2026-05-20T10:00:00Z',
        // Literal says `bar`; URI segment says `foo`. Hook MUST
        // pick `bar` — the canonical predicate is authoritative,
        // URI parser is a legacy fallback only.
        subGraphName: 'bar',
        assertionGraph: 'did:dkg:context-graph:cg-A/foo/assertion/0xabc/conflict-doc',
      }),
    ]);
    await flush();
    const evt = latest!.events.find(e => e.assertionUri === 'urn:assert:conflict');
    expect(evt?.subGraph).toBe('bar');
  });

  // PR #694 review fix — on fetch failure, `resultContextGraphId`
  // must advance to the requested `contextGraphId` so consumers
  // gating on `resultContextGraphId === contextGraphId` (the Code7
  // pattern shared with `useSwmAttributions`) can distinguish "still
  // loading the new graph" from "the new graph errored — final
  // answer". Pre-fix, the catch block cleared `events` but left
  // `resultContextGraphId` stuck on the previous graph (or
  // `undefined` on first load), holding consumers in the stale state
  // until the hook re-ran.
  it('advances `resultContextGraphId` on fetch failure (catch-side mirror of success path)', async () => {
    let latest: AssertionLifecycleEventsResult | null = null;
    function Probe({ id }: { id: string }) {
      latest = useAssertionLifecycleEvents(id);
      return null;
    }
    // Override the default deferred-success fetch with one that rejects.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('SPARQL query failed: 503');
    }) as any;
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-A' }));
    });
    await flush();
    expect(latest!.error).toBe('SPARQL query failed: 503');
    expect(latest!.events).toHaveLength(0);
    // The discriminator now reads "cg-A errored", not "stale".
    expect(latest!.resultContextGraphId).toBe('cg-A');
  });

  // PR #694 Comment 8 — the Comment 3 catch-side fix made
  // `resultContextGraphId === contextGraphId` true in BOTH success
  // and error states, so consumers can no longer distinguish "loaded
  // with zero rows" from "the query failed" via the discriminator
  // alone. The hook's `error` field is the authoritative signal —
  // consumers (ProjectView → ActivityFeed) plumb it through to
  // render an error indicator. This test pins the hook contract:
  // error message is exposed verbatim so the UI can surface it.
  it('preserves the last-known-good `events` cache when a same-graph refresh fails (PR #694 polish carry-over a)', async () => {
    let latest: AssertionLifecycleEventsResult | null = null;
    function Probe({ id }: { id: string | undefined }) {
      latest = useAssertionLifecycleEvents(id);
      return null;
    }
    // First mount on `cg-A`. Resolve with one row so the hook has a
    // populated cache + `resultContextGraphId === 'cg-A'`.
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-A' }));
    });
    await flush();
    pending.get('cg-A')!.resolve([
      row({
        event: 'urn:event:1',
        kind: 'created',
        assertion: 'urn:assertion:1',
        name: 'a1',
        agent: 'urn:agent:1',
        ts: '2026-05-27T12:00:00Z',
      }),
    ]);
    await flush();
    expect(latest!.events).toHaveLength(1);
    expect(latest!.resultContextGraphId).toBe('cg-A');
    expect(latest!.error).toBeNull();

    // User navigates away from Overview — Probe receives `id={undefined}`.
    // Per PR #694 Comment 20 the hook PRESERVES `events` /
    // `resultContextGraphId` in this gated-off state.
    await act(async () => {
      root.render(React.createElement(Probe, { id: undefined }));
    });
    await flush();
    expect(latest!.events).toHaveLength(1);
    expect(latest!.resultContextGraphId).toBe('cg-A');

    // User returns to Overview — Probe receives `id='cg-A'` again,
    // which re-fires the effect. This time the daemon errors
    // (transient 503).
    globalThis.fetch = vi.fn(async () => {
      throw new Error('SPARQL query failed: 503');
    }) as any;
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-A' }));
    });
    await flush();

    // The carry-over fix — the cached row from the earlier success
    // must NOT be clobbered to `[]`. The error message surfaces
    // alongside.
    expect(latest!.error).toBe('SPARQL query failed: 503');
    expect(latest!.events).toHaveLength(1);
    expect(latest!.events[0].assertionUri).toBe('urn:assertion:1');
    // The discriminator still points at the current graph.
    expect(latest!.resultContextGraphId).toBe('cg-A');
  });

  it('clears `events` when a fetch errors on a graph with no prior cached result', async () => {
    // Regression guard for the fix: the cache-preservation only
    // applies when `resultContextGraphId === contextGraphId` (i.e.,
    // we had a prior success on THIS graph). A first-mount error on
    // a fresh graph still produces an empty list.
    let latest: AssertionLifecycleEventsResult | null = null;
    function Probe({ id }: { id: string }) {
      latest = useAssertionLifecycleEvents(id);
      return null;
    }
    globalThis.fetch = vi.fn(async () => {
      throw new Error('SPARQL query failed: 503');
    }) as any;
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-fresh' }));
    });
    await flush();
    expect(latest!.error).toBe('SPARQL query failed: 503');
    expect(latest!.events).toHaveLength(0);
    expect(latest!.resultContextGraphId).toBe('cg-fresh');
  });

  it('exposes the rejection message verbatim on error (Comment 8 distinguishability)', async () => {
    let latest: AssertionLifecycleEventsResult | null = null;
    function Probe({ id }: { id: string }) {
      latest = useAssertionLifecycleEvents(id);
      return null;
    }
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Custom upstream message');
    }) as any;
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-A' }));
    });
    await flush();
    // The exact message must reach the consumer so the title
    // attribute on the inline error indicator surfaces it.
    expect(latest!.error).toBe('Custom upstream message');
    expect(latest!.resultContextGraphId).toBe('cg-A');
    expect(latest!.events).toHaveLength(0);
  });
});
