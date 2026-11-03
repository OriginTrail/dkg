// @vitest-environment happy-dom
//
// One loader and one parser for VM publish receipts, shared by the VM header
// facts and the VM graph anchors (review: normalise receipts once).

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { parseVmReceiptRows, buildVmReceiptQuery, buildKaGraphMemberQuery, addKaGraphMembers, kaGraphOf, useVmReceipts, refreshVmReceipts } from '../src/ui/hooks/useVmReceipts.js';
import { useVmReceiptSummary } from '../src/ui/hooks/useVmReceiptSummary.js';
import { useVerifiableMemoryAnchors } from '../src/ui/hooks/useVerifiableMemoryAnchors.js';
import { invalidateQueryCache } from '../src/ui/query-api.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// useVmReceipts reloads on node events; happy-dom has no EventSource.
class StubEventSource { addEventListener() {} close() {} onerror: (() => void) | null = null; }
vi.stubGlobal('EventSource', StubEventSource);

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
    expect(seen.anchors).toEqual([expect.objectContaining({ tx: '0x9f2c', assertion: A, members: ['urn:x:a'], signers: ['did:dkg:agent:0x1'] })]);
  });

  it("never shows one graph's receipts for another, whatever order responses arrive in", async () => {
    // One deferred response per context graph, resolved by hand.
    const pending = new Map<string, (rows: unknown[]) => void>();
    globalThis.fetch = vi.fn((_url: any, init: any) => new Promise<Response>((resolve) => {
      const cg = JSON.parse(String(init?.body ?? '{}')).contextGraphId as string;
      pending.set(cg, (bindings) => resolve(new Response(JSON.stringify({ result: { bindings } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    })) as any;
    const resolveGraph = async (cg: string, rows: unknown[]) => { pending.get(cg)!(rows); pending.delete(cg); await settle(); await settle(); };
    const alice = { asrt: 'did:dkg:context-graph:graph-a/assertion/0xaaa/one', tx: '0xa1', member: 'urn:a:1', agent: 'did:dkg:agent:alice' };
    const bob = { asrt: 'did:dkg:context-graph:graph-b/assertion/0xbbb/one', tx: '0xb1', member: 'urn:b:1', agent: 'did:dkg:agent:bob' };

    let state!: ReturnType<typeof useVmReceipts>;
    let signers: string[] = [];
    function Probe({ id }: { id: string }) {
      state = useVmReceipts(id);
      const { summary } = useVmReceiptSummary(id);
      signers = summary ? [...summary.signers] : [];
      return null;
    }
    // Graph A loads Alice.
    await act(async () => { root.render(React.createElement(Probe, { id: 'graph-a' })); });
    await resolveGraph('graph-a', [alice]);
    expect(signers).toEqual(['did:dkg:agent:alice']);

    // Switch to graph B while its request is pending: nothing of A is shown.
    await act(async () => { root.render(React.createElement(Probe, { id: 'graph-b' })); });
    await settle();
    expect(state).toMatchObject({ receipts: null, loading: true });
    expect(signers).toEqual([]);

    // Back to A (pending again), then to B; resolve B first...
    await act(async () => { root.render(React.createElement(Probe, { id: 'graph-a' })); });
    await act(async () => { root.render(React.createElement(Probe, { id: 'graph-b' })); });
    await resolveGraph('graph-b', [bob]);
    expect(signers).toEqual(['did:dkg:agent:bob']);
    expect(state.receipts?.map(r => r.members)).toEqual([['urn:b:1']]);
    // ...then the late A response: it must not replace B's results.
    await resolveGraph('graph-a', [alice]);
    expect(signers).toEqual(['did:dkg:agent:bob']);

    // A same-graph refresh keeps B's receipts on screen while it reloads.
    await act(async () => { refreshVmReceipts('graph-b'); });
    await settle();
    expect(state).toMatchObject({ loading: true });
    expect(signers).toEqual(['did:dkg:agent:bob']);
    await resolveGraph('graph-b', [bob, { ...bob, member: 'urn:b:2' }]);
    expect(state.receipts?.[0].members).toEqual(['urn:b:1', 'urn:b:2']);
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

describe('graph-scoped KA membership', () => {
  const AUTHOR = '0x' + 'Ab'.repeat(20);
  const lower = AUTHOR.toLowerCase();

  it('derives the per-KA Verifiable Memory graph from dkg:kaUal', () => {
    expect(kaGraphOf(`did:dkg:base:8453/${AUTHOR}/12`, CG)).toBe(`did:dkg:context-graph:${CG}/_verifiable_memory/${lower}/12`);
    expect(kaGraphOf(`did:dkg:base:8453/${AUTHOR}/12`, CG, 'research')).toBe(`did:dkg:context-graph:${CG}/research/_verifiable_memory/${lower}/12`);
    expect(kaGraphOf('did:dkg:base:8453/not-an-address/12', CG)).toBeUndefined();
    expect(kaGraphOf(`did:dkg:base:8453/${AUTHOR}/12> } DROP ALL {`, CG)).toBeUndefined();
  });

  it('reads members of KA graphs with a VALUES-bounded query and adds them to the receipt', () => {
    const [r] = parseVmReceiptRows([{ asrt: A, tx: '0x1', kaUal: `did:dkg:base:8453/${AUTHOR}/12` }], CG);
    expect(r.members).toEqual([]);
    const query = buildKaGraphMemberQuery([r.kaGraph!, 'bad graph']);
    expect(query).toContain(`VALUES ?g { <${r.kaGraph}> }`);
    expect(query).toContain('LIMIT');
    const [withMembers] = addKaGraphMembers([r], [
      { g: r.kaGraph, member: 'urn:x:one' },
      { g: r.kaGraph, member: 'urn:x:one' },
      { g: 'did:dkg:context-graph:other/_verifiable_memory/0x1/1', member: 'urn:x:elsewhere' },
    ]);
    expect(withMembers.members).toEqual(['urn:x:one']);
  });
});
