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

    // Initial render for cg-A.
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-A' }));
    });
    await flushMicrotasks();
    expect(latest!.resultContextGraphId).toBeUndefined();
    expect(latest!.events).toHaveLength(0);

    // Resolve cg-A's fetch.
    pending.get('cg-A')!.resolve(rowsFor('cg-A'));
    await flushMicrotasks();
    expect(latest!.resultContextGraphId).toBe('cg-A');
    expect(latest!.events).toHaveLength(1);
    expect(latest!.events[0].rootUri).toBe('urn:e:cg-A');

    // Switch to cg-B. The hook still holds cg-A's events until the
    // new SPARQL lands — that's the pre-existing behaviour. The fix
    // is the discriminator: callers can detect the mismatch and
    // suppress downstream rendering until it clears.
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-B' }));
    });
    await flushMicrotasks();
    // Before cg-B's fetch resolves, the result still describes cg-A.
    // A consumer that gates on `resultContextGraphId === currentId`
    // would now suppress these events (they're for the wrong graph).
    expect(latest!.resultContextGraphId).toBe('cg-A');

    // Resolve cg-B; the discriminator catches up.
    pending.get('cg-B')!.resolve(rowsFor('cg-B'));
    await flushMicrotasks();
    expect(latest!.resultContextGraphId).toBe('cg-B');
    expect(latest!.events).toHaveLength(1);
    expect(latest!.events[0].rootUri).toBe('urn:e:cg-B');
  });
});
