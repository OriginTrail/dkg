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
    expect(q).toContain('SELECT ?event ?type ?assertion ?name ?agent ?ts ?subGraph');
    expect(q).toContain('(COUNT(?root) AS ?entityCount)');
  });

  it('UNION-binds created→`prov:generated` and promoted→`prov:used`', () => {
    const q = buildLifecycleEventsQuery('cg-1');
    expect(q).toContain('prov:generated ?assertion');
    expect(q).toContain('FILTER(?type = dkg:AssertionCreated)');
    expect(q).toContain('prov:used ?assertion');
    expect(q).toContain('FILTER(?type = dkg:AssertionPromoted)');
  });

  it('scopes the query to the project `_meta` graph for the given context graph id', () => {
    const q = buildLifecycleEventsQuery('cg-42');
    expect(q).toContain('GRAPH <did:dkg:context-graph:cg-42/_meta>');
  });

  it('groups by all non-aggregated bindings and orders by ?ts DESC with LIMIT 5000', () => {
    const q = buildLifecycleEventsQuery('cg-1');
    expect(q).toContain('GROUP BY ?event ?type ?assertion ?name ?agent ?ts ?subGraph');
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
    subGraph?: string;
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
      subGraph: opts.subGraph ? `"${opts.subGraph}"` : undefined,
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
});
