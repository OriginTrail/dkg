// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useVerifiableMemoryAnchors, anchorsFromReceiptRows } from '../src/ui/hooks/useVerifiableMemoryAnchors.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// C10: anchors come from real on-chain publish receipts in the CG's _meta,
// not from WorkspaceOperation share records.
describe('useVerifiableMemoryAnchors — receipt query', () => {
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

  it('reads publish receipts from the context graph _meta', async () => {
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
    expect(body).toMatchObject({ contextGraphId: 'cg-1' });
    expect(body.sparql).toContain('GRAPH <did:dkg:context-graph:cg-1/_meta>');
    expect(body.sparql).toContain('dkg:publishedAtTx');
    expect(body.sparql).not.toContain('WorkspaceOperation');
  });
});

describe('anchorsFromReceiptRows', () => {
  it('builds one anchor per receipted assertion with its members, agents and sub-graph', () => {
    const A = 'did:dkg:context-graph:cg-1/research/assertion/0xabc/batch-1';
    const anchors = anchorsFromReceiptRows([
      { asrt: A, tx: '0x9f2c7a1d', member: 'urn:x:a', agent: 'did:dkg:agent:0x1', finalizedAt: '"2026-10-31T10:00:00Z"' },
      { asrt: A, tx: '0x9f2c7a1d', member: 'urn:x:b', agent: 'did:dkg:agent:0x1', finalizedAt: '"2026-10-31T10:00:00Z"' },
      { asrt: 'did:dkg:context-graph:cg-1/assertion/0xdef/two', tx: '0x41ab', finalizedAt: '"2026-10-30T10:00:00Z"' },
      { asrt: 'did:dkg:context-graph:cg-1/assertion/0xdef/no-tx' },
    ], 'cg-1');
    expect(anchors).toHaveLength(2);
    expect(anchors[0]).toMatchObject({ opId: '0x9f2c7a1d', roots: ['urn:x:a', 'urn:x:b'], agents: ['did:dkg:agent:0x1'], subGraph: 'research' });
    expect(anchors[1]).toMatchObject({ opId: '0x41ab', agents: ['did:dkg:agent:0xdef'], subGraph: undefined });
  });
});
