// @vitest-environment happy-dom
//
// After a publish the node emits memory_graph_changed for the graph's VM
// layer. The receipt owner must reload on that event (after the debounce,
// through the real query-cache invalidation), so the VM header facts and the
// graph anchors update without a manual refresh. Unrelated events must not
// reload. Own file: the node-event connection is a module-wide singleton.
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useVmReceiptsResource, VmReceiptsProvider } from '../src/ui/hooks/useVmReceipts.js';
import { useVmReceiptSummary } from '../src/ui/hooks/useVmReceiptSummary.js';
import { useVerifiableMemoryAnchors } from '../src/ui/hooks/useVerifiableMemoryAnchors.js';
import { MEMORY_GRAPH_REFRESH_DEBOUNCE_MS } from '../src/ui/hooks/useNodeEvents.js';
import { invalidateQueryCache } from '../src/ui/query-api.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** An EventSource the test can push named events through. */
class ControlledEventSource {
  static current: ControlledEventSource | null = null;
  listeners = new Map<string, Array<(e: { data: string }) => void>>();
  onerror: (() => void) | null = null;
  constructor() { ControlledEventSource.current = this; }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { if (ControlledEventSource.current === this) ControlledEventSource.current = null; }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

const CG = 'cg-live';
const A = `did:dkg:context-graph:${CG}/assertion/0xabc/published-now`;

describe('receipts reload on Verifiable Memory changes', () => {
  let root: Root;
  let container: HTMLDivElement;
  let originalFetch: typeof globalThis.fetch | undefined;
  let rows: unknown[];

  beforeEach(() => {
    vi.stubGlobal('EventSource', ControlledEventSource);
    invalidateQueryCache();
    rows = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ result: { bindings: rows } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as any;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    if (originalFetch) globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  const settle = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
  const afterDebounce = () => settle(MEMORY_GRAPH_REFRESH_DEBOUNCE_MS + 50);
  const emit = async (data: Record<string, unknown>) => {
    await act(async () => { ControlledEventSource.current!.emit('memory_graph_changed', data); });
  };

  it('updates the anchored count and the graph anchors after a matching VM event, and ignores others', async () => {
    const seen: { members?: string[]; anchors?: string[] } = {};
    function Facts() { const { summary } = useVmReceiptSummary(CG); seen.members = summary ? [...summary.members] : undefined; return null; }
    function Anchors() { seen.anchors = useVerifiableMemoryAnchors(CG, null).anchors.map(a => a.tx ?? ''); return null; }
    function Owner() {
      return React.createElement(VmReceiptsProvider, { value: useVmReceiptsResource(CG) },
        React.createElement(Facts), React.createElement(Anchors));
    }
    await act(async () => { root.render(React.createElement(Owner)); });
    await settle();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({ members: [], anchors: [] });
    expect(ControlledEventSource.current).not.toBeNull();

    // The publish lands: its receipt is now readable.
    rows = [{ asrt: A, tx: '0x7777', sealRoot: '"aa"', member: 'urn:x:new' }];

    // Another graph, or this graph's Working Memory: no reload.
    await emit({ contextGraphId: 'cg-other', layers: ['vm'] });
    await emit({ contextGraphId: CG, layers: ['wm'] });
    await afterDebounce();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({ members: [], anchors: [] });

    // This graph's Verifiable Memory: one reload after the debounce, both consumers updated.
    await emit({ contextGraphId: CG, layers: ['vm'] });
    await emit({ contextGraphId: CG, layers: ['vm', 'swm'] });
    await settle();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1); // still debouncing
    await afterDebounce();
    await settle();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(seen).toEqual({ members: ['urn:x:new'], anchors: ['0x7777'] });
  });
});
