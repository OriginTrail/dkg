// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  buildAttributionsQuery,
  useSwmAttributions,
  type SwmAttributionsResult,
} from '../src/ui/hooks/useSwmAttributions.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useSwmAttributions — SPARQL query shape', () => {
  // Codex Code5 (PR #656) — the query MUST order DESC + LIMIT 5000.
  // ASC + LIMIT 5000 keeps the oldest 5000 promotions, so once a
  // project crosses 5000 ops the activity feed silently loses every
  // recent promotion. DESC + LIMIT 5000 returns the most recent
  // window — the activity feed is the load-bearing consumer.
  it('orders by ?publishedAt DESC so the newest promotions are kept inside LIMIT 5000', () => {
    const q = buildAttributionsQuery('cg-1');
    expect(q).toContain('ORDER BY DESC(?publishedAt)');
    expect(q).toContain('LIMIT 5000');
    // Guard against accidentally regressing to plain ASC by leaving
    // the new DESC and the old `ORDER BY ?publishedAt` both present.
    expect(q).not.toMatch(/ORDER BY \?publishedAt\s+LIMIT/);
  });

  // Codex review (PR #1055) — with contextGraphId removed from the request
  // (B2), scoping rests entirely on this STRSTARTS prefix, so it MUST end in
  // "/" to be exact. A bare "did:dkg:context-graph:cg-1" prefix would also
  // match a sibling CG like cg-10 / cg-1-foo and merge its _shared_memory_meta
  // attribution rows into the legend.
  it('scopes via an exact "<cgUri>/" STRSTARTS prefix so sibling CGs do not leak in', () => {
    const q = buildAttributionsQuery('cg-1');
    expect(q).toContain('STRSTARTS(STR(?g), "did:dkg:context-graph:cg-1/")');
    // The slash-less prefix would over-match cg-10 / cg-1-foo.
    expect(q).not.toMatch(/STRSTARTS\(STR\(\?g\), "did:dkg:context-graph:cg-1"\)/);
  });
});

// Codex Code7 (PR #656) — the hook returns its previous-graph result
// during the transition window between context-graph switch and the
// new SPARQL resolving, so callers that key off the result without a
// discriminator (e.g. feeding `events` into the Overview activity
// feed) can briefly show rows from the prior project. The hook now
// exposes `resultContextGraphId` so consumers can gate on it.
describe('useSwmAttributions — stale-on-switch protection', () => {
  let root: Root;
  let container: HTMLDivElement;
  let originalFetch: typeof globalThis.fetch | undefined;
  // Deferred-promise queue per contextGraphId so the test can drive
  // when each fetch resolves.
  let pending: Map<string, { resolve: (rows: any[]) => void }>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    pending = new Map();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      // B2: the POST body no longer carries contextGraphId (it scoped the
      // engine to CG-direct graphs and dropped per-sub-graph attribution).
      // Recover the cgId from the SPARQL's exact STRSTARTS prefix
      // ("did:dkg:context-graph:<cgId>/") to route the deferred promise.
      // Capture up to the trailing `/"` (non-greedy) rather than `[^"/]+`, so
      // canonical slash-containing ids like `<wallet>/project` route under the
      // full key instead of being truncated at the first `/`.
      const cgId: string = String(body.sparql).match(/context-graph:(.+?)\/"/)?.[1] ?? '';
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

  async function flushMicrotasks() {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  function rowsFor(cgId: string) {
    return [{
      op:          `"urn:op:${cgId}"`,
      root:        `"urn:e:${cgId}"`,
      agent:       `"did:dkg:agent:0x${cgId.padEnd(40, '0')}"`,
      publishedAt: `"2026-05-22T10:00:00Z"`,
      g:           `"did:dkg:context-graph:${cgId}/_shared_memory_meta"`,
    }];
  }

  it('lags resultContextGraphId behind the prop during a context-graph switch (Code7)', async () => {
    let latest: SwmAttributionsResult | null = null;
    function Probe({ id }: { id: string }) {
      latest = useSwmAttributions(id);
      return null;
    }

    // Initial render for acme/alpha.
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'acme/alpha' }));
    });
    await flushMicrotasks();
    expect(latest!.resultContextGraphId).toBeUndefined();
    expect(latest!.events).toHaveLength(0);

    // Resolve acme/alpha's fetch.
    pending.get('acme/alpha')!.resolve(rowsFor('acme/alpha'));
    await flushMicrotasks();
    expect(latest!.resultContextGraphId).toBe('acme/alpha');
    expect(latest!.events).toHaveLength(1);
    expect(latest!.events[0].rootUri).toBe('urn:e:acme/alpha');

    // Switch to acme/beta. The hook still holds acme/alpha's events until the
    // new SPARQL lands — that's the pre-existing behaviour. The fix
    // is the discriminator: callers can detect the mismatch and
    // suppress downstream rendering until it clears.
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'acme/beta' }));
    });
    await flushMicrotasks();
    // Before acme/beta's fetch resolves, the result still describes acme/alpha.
    // A consumer that gates on `resultContextGraphId === currentId`
    // would now suppress these events (they're for the wrong graph).
    expect(latest!.resultContextGraphId).toBe('acme/alpha');

    // Resolve acme/beta; the discriminator catches up.
    pending.get('acme/beta')!.resolve(rowsFor('acme/beta'));
    await flushMicrotasks();
    expect(latest!.resultContextGraphId).toBe('acme/beta');
    expect(latest!.events).toHaveLength(1);
    expect(latest!.events[0].rootUri).toBe('urn:e:acme/beta');
  });
});

// B2 (DKG-NODE-ISSUES-FOR-RC17) — the attribution fetch MUST NOT send
// contextGraphId. The SPARQL scopes itself to the CG via STRSTARTS(?g, …)
// and must read every sub-graph's <cg>/<sg>/_shared_memory_meta partition;
// sending contextGraphId makes the daemon constrain GRAPH ?g to CG-direct
// graphs only, so the legend under-counted agents (showed 1 of 5 agents live).
describe('useSwmAttributions — B2 POST body scoping', () => {
  let root: Root;
  let container: HTMLDivElement;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { bindings: [] } }),
    } as any)) as any;
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it('omits contextGraphId from the /api/query POST body so all sub-graph partitions are reached', async () => {
    function Probe({ id }: { id: string }) {
      useSwmAttributions(id);
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-1' }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const body = JSON.parse(String((calls[0][1] as any)?.body ?? '{}'));
    expect(body.sparql).toContain('_shared_memory_meta');
    expect(body).not.toHaveProperty('contextGraphId');
  });
});


// PR #2333 review — the helper was well covered but the user-visible wiring was
// not, so a regression that recomputed node colours from the raw hash instead
// of consuming the collision-resolved legend colour would go unnoticed. These
// agents all hash to the SAME palette slot under the old scheme, so at least
// one must receive a probed slot for the assertions below to mean anything.
const COLLIDING_AGENTS = [
  'did:dkg:agent:0xa4c123b1612dd272d1371c17149d439536b3216f',
  'did:dkg:agent:0x5fc324bdb2e1142a21c402364f9572b85a8e48f6',
  'did:dkg:agent:0x49ddb14f71010b93b7d946bf54074e3248c801be',
];

describe('useSwmAttributions — legend and node colours agree (GH#1128)', () => {
  let root: Root;
  let container: HTMLDivElement;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          bindings: COLLIDING_AGENTS.map((agent, i) => ({
            op: { value: `urn:op:${i}` },
            root: { value: `urn:e:${i}` },
            agent: { value: agent },
            publishedAt: { value: '2026-05-22T10:00:00Z' },
            g: { value: 'did:dkg:context-graph:cg-1/_shared_memory_meta' },
          })),
        },
      }),
    })) as any;
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it('gives colliding agents distinct legend colours, and tints each root to match', async () => {
    let latest: SwmAttributionsResult | null = null;
    function Probe() {
      latest = useSwmAttributions('cg-1');
      return null;
    }
    await act(async () => { root.render(React.createElement(Probe)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const palette = latest!.palette;
    expect(palette.length).toBe(COLLIDING_AGENTS.length);

    // 1. The legend itself must not repeat a colour.
    expect(new Set(palette.map((e) => e.color)).size).toBe(palette.length);

    // 2. Every single-agent root must be tinted with ITS OWN legend colour —
    //    the half of #1128 that a helper-only test cannot see.
    const colorFor = new Map(palette.map((e) => [e.agent, e.color]));
    for (const [uri, list] of latest!.attributions) {
      if (list.length !== 1) continue;
      expect(latest!.nodeColors[uri]).toBe(colorFor.get(list[0]!.agent));
    }
    expect(Object.keys(latest!.nodeColors).length).toBeGreaterThan(0);
  });
});
