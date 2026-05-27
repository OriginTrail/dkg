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
    // PR #694 review fix — the projection swapped `?subGraph` for
    // `?assertionGraph` since the lifecycle writers don't emit
    // `dkg:subGraphName`; the slug is derived client-side from the
    // assertion-graph URI shape.
    expect(q).toContain('SELECT ?event ?type ?assertion ?name ?agent ?ts ?assertionGraph');
    expect(q).toContain('(COUNT(?root) AS ?entityCount)');
    expect(q).toContain('OPTIONAL { ?assertion dkg:assertionGraph ?assertionGraph }');
    // Guard: the dead `dkg:subGraphName` OPTIONAL must not regress.
    expect(q).not.toContain('dkg:subGraphName');
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
    expect(q).toContain('GROUP BY ?event ?type ?assertion ?name ?agent ?ts ?assertionGraph');
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

  // PR #694 review fix — the sub-graph slug is derived from
  // `dkg:assertionGraph` (the URI shape mirrors
  // `contextGraphAssertionUri`), not the never-emitted
  // `dkg:subGraphName`. A sub-graph-scoped assertion URI carries
  // the slug as its first path segment after the cgId; a
  // root-bucket assertion has `assertion/` directly.
  it('derives `subGraph` from `dkg:assertionGraph` for sub-graph-scoped assertions', async () => {
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
        event: 'urn:evt:c-1', kind: 'created',
        assertion: 'urn:assert:scoped', name: 'scoped-doc',
        agent: 'did:dkg:agent:alice', ts: '2026-05-20T10:00:00Z',
        assertionGraph: 'did:dkg:context-graph:cg-A/research/assertion/0xabc/scoped-doc',
      }),
      row({
        event: 'urn:evt:c-2', kind: 'created',
        assertion: 'urn:assert:root', name: 'root-doc',
        agent: 'did:dkg:agent:alice', ts: '2026-05-20T11:00:00Z',
        assertionGraph: 'did:dkg:context-graph:cg-A/assertion/0xabc/root-doc',
      }),
    ]);
    await flush();
    const scoped = latest!.events.find(e => e.assertionUri === 'urn:assert:scoped');
    const rootBucket = latest!.events.find(e => e.assertionUri === 'urn:assert:root');
    expect(scoped?.subGraph).toBe('research');
    expect(rootBucket?.subGraph).toBeUndefined();
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
