// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  useVerifiableMemoryAnchors,
  newestFirst,
  buildDecorationTriples,
  VIZ_ANCHOR_TYPE,
  VIZ_PRED_ANCHORED_IN,
  VIZ_PRED_SIGNED_BY,
  VIZ_AGENT_TYPE,
  type VerifiableMemoryAnchorsResult,
} from '../src/ui/hooks/useVerifiableMemoryAnchors.js';
import { parseVmReceiptRows, useVmReceiptsResource, VmReceiptsProvider, type VmReceiptsResource } from '../src/ui/hooks/useVmReceipts.js';

const anchorsFromReceiptRows = (rows: Array<Record<string, unknown>>, cg: string) => newestFirst(parseVmReceiptRows(rows, cg));
/** Render `child` under the graph's receipt owner, as ProjectView does. */
const owned = (id: string, child: React.ReactElement) => React.createElement(function Owner() {
  return React.createElement(VmReceiptsProvider, { value: useVmReceiptsResource(id) }, child);
});
const AUTHOR = '0x' + 'ab'.repeat(20);

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// useVmReceipts reloads on node events; happy-dom has no EventSource.
class StubEventSource { addEventListener() {} close() {} onerror: (() => void) | null = null; }
vi.stubGlobal('EventSource', StubEventSource);

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

  it('reads publish receipts from the Context Graph _meta', async () => {
    function Probe({ id }: { id: string }) {
      useVerifiableMemoryAnchors(id);
      return null;
    }
    await act(async () => {
      root.render(owned('cg-1', React.createElement(Probe, { id: 'cg-1' })));
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

  it('turns receipts (with and without a finalize time) into graph decorations', async () => {
    const A = 'did:dkg:context-graph:cg-1/assertion/0xabc/notes';
    vi.mocked(fetch).mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { bindings: [
        // Dated receipt with a member row and an explicit signer.
        { asrt: A, tx: '0x9f2c7a1d', sealRoot: '"aa"', member: 'urn:x:a', agent: 'did:dkg:agent:0x1', finalizedAt: '"2026-10-31T10:00:00Z"' },
        // No finalize time, no attribution row: signer from the author address.
        { asrt: 'did:dkg:context-graph:cg-1/assertion/0xdef/two', tx: '0x41ab', sealRoot: '"aa"', member: 'urn:x:b' },
        // Receipt whose only member is not visible in this layer.
        { asrt: 'did:dkg:context-graph:cg-1/assertion/0xdef/hidden', tx: '0x77', sealRoot: '"aa"', member: 'urn:x:not-visible', finalizedAt: '"2026-10-29T10:00:00Z"' },
      ] } }),
    } as any));
    let result: VerifiableMemoryAnchorsResult | null = null;
    // urn:x:a by member row; A/entity/1 only by the assertion URI prefix.
    const visible = new Set(['urn:x:a', 'urn:x:b', `${A}/entity/1`]);
    function Probe() {
      result = useVerifiableMemoryAnchors('cg-1', visible);
      return null;
    }
    await act(async () => { root.render(owned('cg-1', React.createElement(Probe))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const r = result as unknown as VerifiableMemoryAnchorsResult;
    expect(r.error).toBeNull();
    expect(r.anchors.map(a => [a.tx, a.finalizedAt])).toEqual([
      ['0x9f2c7a1d', '2026-10-31T10:00:00.000Z'],
      ['0x77', '2026-10-29T10:00:00.000Z'],
      ['0x41ab', null],
    ]);
    const t = r.decorationTriples;
    // The hidden receipt draws no anchor; the other two do.
    expect(t.filter(x => x.object === VIZ_ANCHOR_TYPE).map(x => x.subject).sort())
      .toEqual(['urn:dkg:viz:anchor:0x41ab', 'urn:dkg:viz:anchor:0x9f2c7a1d']);
    expect(t.filter(x => x.predicate === VIZ_PRED_ANCHORED_IN).map(x => `${x.subject} → ${x.object}`).sort()).toEqual([
      `${A}/entity/1 → urn:dkg:viz:anchor:0x9f2c7a1d`,
      'urn:x:a → urn:dkg:viz:anchor:0x9f2c7a1d',
      'urn:x:b → urn:dkg:viz:anchor:0x41ab',
    ]);
    const signers = t.filter(x => x.predicate === VIZ_PRED_SIGNED_BY).map(x => `${x.subject} → ${decodeURIComponent(x.object)}`).sort();
    expect(signers).toEqual([
      'urn:dkg:viz:anchor:0x41ab → urn:dkg:viz:agent:did:dkg:agent:0xdef',
      'urn:dkg:viz:anchor:0x9f2c7a1d → urn:dkg:viz:agent:did:dkg:agent:0x1',
    ]);
    expect(t.filter(x => x.object === VIZ_AGENT_TYPE)).toHaveLength(2);
  });

  it('anchors entities of a graph-scoped KA through its per-KA graph', async () => {
    const A = `did:dkg:context-graph:cg-1/assertion/${AUTHOR}/note`;
    const KA_GRAPH = `did:dkg:context-graph:cg-1/_verifiable_memory/${AUTHOR}/7`;
    vi.mocked(fetch).mockImplementation(async (_url: any, init: any) => {
      const sparql = String(JSON.parse(String(init?.body ?? '{}')).sparql ?? '');
      const bindings = sparql.includes('VALUES ?g')
        ? [{ g: KA_GRAPH, member: 'urn:member-one:note' }]
        // A v2 seal: no member rows, the content lives in the KA graph.
        : [{ asrt: A, tx: '0x5555', sealRoot: '"aa"', kaUal: `did:dkg:hardhat:31337/${AUTHOR}/7`, finalizedAt: '"2026-10-31T10:00:00Z"' }];
      return { ok: true, status: 200, json: async () => ({ result: { bindings } }) } as any;
    });
    let result: VerifiableMemoryAnchorsResult | null = null;
    const visible = new Set(['urn:member-one:note']);
    function Probe() {
      result = useVerifiableMemoryAnchors('cg-1', visible);
      return null;
    }
    await act(async () => { root.render(owned('cg-1', React.createElement(Probe))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const r = result as unknown as VerifiableMemoryAnchorsResult;
    const membershipCall = vi.mocked(fetch).mock.calls.map(c => JSON.parse(String((c[1] as any)?.body ?? '{}')).sparql as string).find(q => q.includes('VALUES ?g'));
    expect(membershipCall).toContain(`<${KA_GRAPH}>`);
    expect(r.anchors[0]).toMatchObject({ tx: '0x5555', kaGraph: KA_GRAPH, members: ['urn:member-one:note'] });
    expect(r.decorationTriples.filter(x => x.predicate === VIZ_PRED_ANCHORED_IN).map(x => `${x.subject} → ${x.object}`))
      .toEqual(['urn:member-one:note → urn:dkg:viz:anchor:0x5555']);
  });

  it("reloads through the graph's receipt provider without remounting", async () => {
    let published = false;
    vi.mocked(fetch).mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { bindings: published
        ? [{ asrt: 'did:dkg:context-graph:cg-1/assertion/0xabc/new', tx: '0x6666', sealRoot: '"aa"', member: 'urn:x:new' }]
        : [] } }),
    } as any));
    let result: VerifiableMemoryAnchorsResult | null = null;
    let resource!: VmReceiptsResource;
    function Probe() {
      result = useVerifiableMemoryAnchors('cg-1');
      return null;
    }
    function Owner() {
      resource = useVmReceiptsResource('cg-1');
      return React.createElement(VmReceiptsProvider, { value: resource }, React.createElement(Probe));
    }
    await act(async () => { root.render(React.createElement(Owner)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect((result as unknown as VerifiableMemoryAnchorsResult).anchors).toEqual([]);

    published = true;
    await act(async () => { resource.refresh(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect((result as unknown as VerifiableMemoryAnchorsResult).anchors.map(a => a.tx)).toEqual(['0x6666']);
  });
});

describe('anchors from receipts', () => {
  it('builds one anchor per receipted assertion with its members, agents and sub-graph', () => {
    const A = 'did:dkg:context-graph:cg-1/research/assertion/0xabc/batch-1';
    const anchors = anchorsFromReceiptRows([
      { asrt: A, tx: '0x9f2c7a1d', sealRoot: '"aa"', member: 'urn:x:a', agent: 'did:dkg:agent:0x1', finalizedAt: '"2026-10-31T10:00:00Z"' },
      { asrt: A, tx: '0x9f2c7a1d', sealRoot: '"aa"', member: 'urn:x:b', agent: 'did:dkg:agent:0x1', finalizedAt: '"2026-10-31T10:00:00Z"' },
      { asrt: 'did:dkg:context-graph:cg-1/assertion/0xdef/two', tx: '0x41ab', sealRoot: '"aa"', finalizedAt: '"2026-10-30T10:00:00Z"' },
      { asrt: 'did:dkg:context-graph:cg-1/assertion/0xdef/no-tx' },
    ], 'cg-1');
    expect(anchors).toHaveLength(2);
    expect(anchors[0]).toMatchObject({ tx: '0x9f2c7a1d', members: ['urn:x:a', 'urn:x:b'], signers: ['did:dkg:agent:0x1'], subGraph: 'research' });
    expect(anchors[1]).toMatchObject({ tx: '0x41ab', signers: ['did:dkg:agent:0xdef'], subGraph: undefined });
  });
});

describe('receipts without a finalize time', () => {
  const rows = [
    { asrt: 'did:dkg:context-graph:cg-1/assertion/0xabc/undated', tx: '0x1111', sealRoot: '"aa"', member: 'urn:x:a', agent: 'did:dkg:agent:0x1' },
    { asrt: 'did:dkg:context-graph:cg-1/assertion/0xabc/garbled', tx: '0x2222', sealRoot: '"aa"', member: 'urn:x:b', finalizedAt: '"not a date"' },
    { asrt: 'did:dkg:context-graph:cg-1/assertion/0xabc/dated', tx: '0x3333', sealRoot: '"aa"', member: 'urn:x:c', finalizedAt: '"2026-10-31T10:00:00Z"' },
  ];

  it('keeps the anchor with an unknown time and sorts it after dated ones', () => {
    const anchors = anchorsFromReceiptRows(rows, 'cg-1');
    expect(anchors.map(a => a.tx)).toEqual(['0x3333', '0x1111', '0x2222']);
    expect(anchors.map(a => a.finalizedAt)).toEqual(['2026-10-31T10:00:00.000Z', null, null]);
  });

  it('builds decorations without throwing and says the time is unknown', () => {
    const anchors = anchorsFromReceiptRows(rows, 'cg-1');
    const triples = buildDecorationTriples(anchors, new Set(['urn:x:a', 'urn:x:b', 'urn:x:c']));
    const desc = (op: string) => triples.find(t => t.subject === `urn:dkg:viz:anchor:${op}` && t.predicate === 'http://schema.org/description')?.object;
    expect(desc('0x1111')).toBe('"Published 1 KA · finalize time unknown"');
    expect(desc('0x3333')).toBe('"Published 1 KA · finalized 2026-10-31T10:00:00.000Z"');
    const name = triples.find(t => t.subject === 'urn:dkg:viz:anchor:0x1111' && t.predicate === 'http://schema.org/name')?.object;
    expect(name).toBe('"anchor 0x1111"');
  });

  it('links entities under the assertion URI, but not siblings that share a prefix', () => {
    const A = 'did:dkg:context-graph:cg-1/assertion/0xabc/note';
    const anchors = anchorsFromReceiptRows([{ asrt: A, tx: '0x4444', sealRoot: '"aa"', finalizedAt: '"2026-10-31T10:00:00Z"' }], 'cg-1');
    const triples = buildDecorationTriples(anchors, new Set([`${A}/entity/1`, `${A}book/entity/1`]));
    expect(triples.filter(t => t.predicate === VIZ_PRED_ANCHORED_IN).map(t => t.subject)).toEqual([`${A}/entity/1`]);
  });

  it('says why an anchor has no transaction', () => {
    const A = 'did:dkg:context-graph:cg-1/assertion/0xabc/twice';
    const anchors = anchorsFromReceiptRows([{ asrt: A, tx: '0x1', sealRoot: '"aa"', member: 'urn:x:t' }, { asrt: A, tx: '0x2', sealRoot: '"aa"', member: 'urn:x:t' }], 'cg-1');
    expect(anchors[0].tx).toBeNull();
    const desc = buildDecorationTriples(anchors, null).find(t => t.predicate === 'http://schema.org/description')?.object;
    expect(desc).toContain('published more than once; the current transaction is not recorded');
    expect(desc).not.toContain('finalized materialization');
  });
});
