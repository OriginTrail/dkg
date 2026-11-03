// @vitest-environment happy-dom
//
// One loader and one parser for VM publish receipts, shared by the VM header
// facts and the VM graph anchors (review: normalise receipts once).

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { parseVmReceiptRows, buildVmReceiptQuery, buildKaGraphMemberQuery, addKaGraphMembers, kaGraphOf, useVmReceipts, useVmReceiptsResource, VmReceiptsProvider } from '../src/ui/hooks/useVmReceipts.js';
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
        confirmation: 'receipt',
        finalizedAt: '2026-10-31T10:00:00.000Z',
        members: ['urn:x:a', 'urn:x:b'],
        signers: ['did:dkg:agent:0x1', 'did:dkg:agent:0x2'],
        subGraph: undefined,
      },
      {
        assertion: B,
        tx: '0x41ab',
        confirmation: 'receipt',
        finalizedAt: null,
        members: ['urn:x:c'],
        // No attribution row: the author address in the assertion URI.
        signers: ['did:dkg:agent:0xdef'],
        subGraph: 'research',
      },
    ]);
  });

  it('names no transaction when a named assertion was published more than once, whatever the row order', () => {
    // Append-only receipts: nothing pairs a hash with its block, so neither is "current".
    const rows = [
      { asrt: A, tx: '0xff01', member: 'urn:x:a' },
      { asrt: A, tx: '0x1102', member: 'urn:x:a' },
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const [r] = parseVmReceiptRows(order, CG);
      expect(r).toMatchObject({ assertion: A, tx: null, confirmation: 'receipt', members: ['urn:x:a'] });
    }
  });

  it('takes the transaction from the UAL metadata over any named receipt', () => {
    const UAL = `did:dkg:hardhat:31337/${'0x' + 'ab'.repeat(20)}/9`;
    const rows = [
      { asrt: A, tx: '0xold', kaUal: UAL, finalizedAt: '"2026-10-30T10:00:00Z"' },
      { asrt: A, tx: '0xolder', kaUal: UAL },
      { ual: UAL, kaGraph: 'urn:g:ka9', tx: '0xcurrent', kind: 'transaction' },
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const receipts = parseVmReceiptRows(order, CG);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ assertion: A, ual: UAL, tx: '0xcurrent', confirmation: 'transaction', kaGraph: 'urn:g:ka9', finalizedAt: '2026-10-30T10:00:00.000Z' });
    }
    // UAL metadata with more than one hash proves nothing; a single named receipt still does.
    const [r] = parseVmReceiptRows([
      { asrt: A, tx: '0xnamed', kaUal: UAL },
      { ual: UAL, kaGraph: 'urn:g:ka9', tx: '0xa', kind: 'transaction' },
      { ual: UAL, kaGraph: 'urn:g:ka9', tx: '0xb', kind: 'transaction' },
    ], CG);
    expect(r).toMatchObject({ tx: '0xnamed', confirmation: 'receipt' });
  });

  it('folds confirmed KA metadata on the UAL: transaction-confirmed and receiptless finalized materialization', () => {
    const UAL = `did:dkg:hardhat:31337/${'0x' + 'ab'.repeat(20)}/9`;
    const KA_GRAPH = `did:dkg:context-graph:${CG}/_verifiable_memory/${'0x' + 'ab'.repeat(20)}/9`;
    const receipts = parseVmReceiptRows([
      // A publish or sync time on the UAL is not a seal time: finalizedAt stays unknown.
      { ual: UAL, kaGraph: KA_GRAPH, tx: '0xv2', kind: 'transaction', finalizedAt: '"2026-10-31T10:00:00Z"', agent: 'did:dkg:agent:0x9' },
      // Synced, finalized materialization: anchored, but no local transaction hash.
      { ual: 'did:dkg:hardhat:31337/0x' + 'cd'.repeat(20) + '/3', kaGraph: 'urn:g:synced', kind: 'finalized-materialization', agent: 'peer-1' },
      // A confirmed status with no provenance at all is not anchored.
      { ual: 'did:dkg:hardhat:31337/0x' + 'ef'.repeat(20) + '/4', kaGraph: 'urn:g:bare' },
      // Nor is a transaction kind with two hashes and no named receipt.
      { ual: 'did:dkg:hardhat:31337/0x' + '12'.repeat(20) + '/5', kaGraph: 'urn:g:two', tx: '0x1', kind: 'transaction' },
      { ual: 'did:dkg:hardhat:31337/0x' + '12'.repeat(20) + '/5', kaGraph: 'urn:g:two', tx: '0x2', kind: 'transaction' },
    ], CG);
    expect(receipts).toEqual([
      { assertion: UAL, ual: UAL, tx: '0xv2', confirmation: 'transaction', finalizedAt: null, members: [], signers: ['did:dkg:agent:0x9'], subGraph: undefined, kaGraph: KA_GRAPH },
      { assertion: 'did:dkg:hardhat:31337/0x' + 'cd'.repeat(20) + '/3', ual: 'did:dkg:hardhat:31337/0x' + 'cd'.repeat(20) + '/3', tx: null, confirmation: 'finalized-materialization', finalizedAt: null, members: [], signers: ['peer-1'], subGraph: undefined, kaGraph: 'urn:g:synced' },
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

  it('one provider load serves both consumers, and one refresh updates both', async () => {
    respond([{ asrt: A, tx: '0x9f2c', member: 'urn:x:a', agent: 'did:dkg:agent:0x1' }]);
    const seen: { summary?: any; anchors?: any; resource?: ReturnType<typeof useVmReceiptsResource> } = {};
    function Summary() { seen.summary = useVmReceiptSummary(CG).summary; return null; }
    function Anchors() { seen.anchors = useVerifiableMemoryAnchors(CG, null).anchors; return null; }
    function Owner() {
      const resource = useVmReceiptsResource(CG);
      seen.resource = resource;
      return React.createElement(VmReceiptsProvider, { value: resource }, React.createElement(Summary), React.createElement(Anchors));
    }
    await act(async () => { root.render(React.createElement(Owner)); });
    await settle();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect([...seen.summary.members]).toEqual(['urn:x:a']);
    expect(seen.anchors.map((a: any) => a.members)).toEqual([['urn:x:a']]);

    invalidateQueryCache();
    respond([
      { asrt: A, tx: '0x9f2c', member: 'urn:x:a', agent: 'did:dkg:agent:0x1' },
      { asrt: A, tx: '0x9f2c', member: 'urn:x:b', agent: 'did:dkg:agent:0x1' },
    ]);
    await act(async () => { seen.resource!.refresh(); });
    await settle();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect([...seen.summary.members].sort()).toEqual(['urn:x:a', 'urn:x:b']);
    expect(seen.anchors.map((a: any) => a.members)).toEqual([['urn:x:a', 'urn:x:b']]);
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
    await act(async () => { state.refresh(); });
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
