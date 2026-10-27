// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useVerifiableMemoryAnchors } from '../src/ui/hooks/useVerifiableMemoryAnchors.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Server-owned partition discovery includes registered subgraphs and excludes child CGs.
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

  it('opts into server-scoped anchors across registered subgraphs', async () => {
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
    expect(body).toMatchObject({ contextGraphId: 'cg-1', includeContextGraphPartitions: true, includeSharedMemoryMeta: true });
    expect(body.sparql).toContain('STRENDS(STR(?g), "/_shared_memory_meta")');
    expect(body.sparql).not.toContain('STRSTARTS');
  });
});
