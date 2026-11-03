// @vitest-environment happy-dom
//
// One loader and one parser for VM publish receipts, shared by the VM header
// facts and the VM graph anchors (review: normalise receipts once).

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { parseVmReceiptRows, buildVmReceiptQuery, useVmReceipts } from '../src/ui/hooks/useVmReceipts.js';
import { useVmReceiptSummary } from '../src/ui/hooks/useVmReceiptSummary.js';
import { useVerifiableMemoryAnchors } from '../src/ui/hooks/useVerifiableMemoryAnchors.js';
import { invalidateQueryCache } from '../src/ui/query-api.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CG = 'cg-1';
const A = `did:dkg:context-graph:${CG}/assertion/0xabc/notes`;
const B = `did:dkg:context-graph:${CG}/research/assertion/0xdef/batch`;

describe('parseVmReceiptRows', () => {
  it('folds rows into one typed receipt per assertion', () => {
    const receipts = parseVmReceiptRows([
      { asrt: A, tx: '"0x9f2c"', member: 'urn:x:a', agent: 'did:dkg:agent:0x1', finalizedAt: '"2026-10-30T10:00:00Z"' },
      { asrt: A, tx: '"0x9f2c"', member: 'urn:x:b', agent: 'did:dkg:agent:0x2', finalizedAt: '"2026-10-31T10:00:00Z"' },
      { asrt: A, tx: '"0x9f2c"', member: 'urn:x:a', agent: 'did:dkg:agent:0x1' },
      // SPARQL JSON binding objects are read the same way.
      { asrt: { type: 'uri', value: B }, tx: { type: 'literal', value: '0x41ab' }, member: { type: 'uri', value: 'urn:x:c' } },
      // Not receipts: no assertion, or no transaction.
      { tx: '0xdead' },
      { asrt: `did:dkg:context-graph:${CG}/assertion/0xabc/no-tx` },
    ], CG);
    expect(receipts).toEqual([
      {
        assertion: A,
        tx: '0x9f2c',
        finalizedAt: '2026-10-31T10:00:00.000Z',
        members: ['urn:x:a', 'urn:x:b'],
        signers: ['did:dkg:agent:0x1', 'did:dkg:agent:0x2'],
        subGraph: undefined,
      },
      {
        assertion: B,
        tx: '0x41ab',
        finalizedAt: null,
        members: ['urn:x:c'],
        // No attribution row: the author address in the assertion URI.
        signers: ['did:dkg:agent:0xdef'],
        subGraph: 'research',
      },
    ]);
  });

  it('treats an unparseable finalize time as unknown', () => {
    const [r] = parseVmReceiptRows([{ asrt: A, tx: '0x1', finalizedAt: '"soon"' }], CG);
    expect(r.finalizedAt).toBeNull();
  });
});

describe('useVmReceipts', () => {
  let root: Root;
  let container: HTMLDivElement;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    invalidateQueryCache();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = globalThis.fetch;
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  const respond = (bindings: unknown[], status = 200) => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ result: { bindings } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as any;
  };
  const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

  it('header facts and graph anchors share one request and the same records', async () => {
    respond([{ asrt: A, tx: '0x9f2c', member: 'urn:x:a', agent: 'did:dkg:agent:0x1', finalizedAt: '"2026-10-31T10:00:00Z"' }]);
    const seen: { summary?: any; anchors?: any } = {};
    function Both() {
      seen.summary = useVmReceiptSummary(CG).summary;
      seen.anchors = useVerifiableMemoryAnchors(CG, new Set(['urn:x:a'])).anchors;
      return null;
    }
    await act(async () => { root.render(React.createElement(Both)); });
    await settle();

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    expect(body).toMatchObject({ contextGraphId: CG, sparql: buildVmReceiptQuery(CG) });
    expect([...seen.summary.members]).toEqual(['urn:x:a']);
    expect(seen.anchors).toEqual([expect.objectContaining({ opId: '0x9f2c', opUri: A, roots: ['urn:x:a'], agents: ['did:dkg:agent:0x1'] })]);
  });

  it('reports loading, then an error without receipts when the query fails', async () => {
    respond([], 500);
    const states: Array<ReturnType<typeof useVmReceipts>> = [];
    function Probe() {
      states.push(useVmReceipts(CG));
      return null;
    }
    await act(async () => { root.render(React.createElement(Probe)); });
    await settle();
    expect(states.some(s => s.loading)).toBe(true);
    const last = states[states.length - 1];
    expect(last).toMatchObject({ receipts: null, loading: false });
    expect(last.error).toBeTruthy();
  });

  it('does not query for a missing or unsafe graph id', async () => {
    respond([]);
    function Probe({ id }: { id?: string }) {
      useVmReceipts(id);
      return null;
    }
    await act(async () => { root.render(React.createElement(Probe, { id: undefined })); });
    await act(async () => { root.render(React.createElement(Probe, { id: 'x> } DROP' })); });
    await settle();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
