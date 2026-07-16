// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useVerifiableMemoryAnchors } from '../src/ui/hooks/useVerifiableMemoryAnchors.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Same bug class as B2 (DKG-NODE-ISSUES-FOR-RC17): buildAnchorsQuery already
// scopes to the CG via STRSTARTS(?g, …) and enumerates EVERY sub-graph's
// <cg>/<sg>/_shared_memory_meta partition, so the fetch MUST NOT also send
// contextGraphId — that makes the daemon constrain GRAPH ?g to CG-direct
// graphs only, dropping per-sub-graph anchors/attribution.
describe('useVerifiableMemoryAnchors — POST body scoping', () => {
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
      useVerifiableMemoryAnchors(id);
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
    // Codex review (PR #1055) — exact "<cgUri>/" prefix so a sibling CG
    // (cg-10 / cg-1-foo) can't leak its anchors in once contextGraphId is gone.
    expect(body.sparql).toContain('STRSTARTS(STR(?g), "did:dkg:context-graph:cg-1/")');
  });
});
