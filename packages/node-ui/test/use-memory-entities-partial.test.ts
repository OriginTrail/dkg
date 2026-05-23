// @vitest-environment happy-dom
//
// Regression: a single layer query failing must NOT blank the other
// layers, and must surface `partial: true` (not `error`) so consumers
// (DashboardView size card / MemoryStackView) don't present truncated
// counts as exact. (Codex round-7/8.)

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useMemoryEntities } from '../src/ui/hooks/useMemoryEntities.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  constructor(readonly url: string) { MockEventSource.instances.push(this); }
  addEventListener(t: string, l: (e: MessageEvent) => void) {
    const a = this.listeners.get(t) ?? []; a.push(l); this.listeners.set(t, a);
  }
  close() {}
}

function triple(subject: string, graph: string) {
  return { s: { value: subject }, p: { value: RDF_TYPE }, o: { value: 'http://schema.org/Thing' }, g: { value: graph } };
}

function Probe({ id }: { id: string }) {
  // Dashboard-style consumer: opts into failed-vs-empty signalling.
  const m = useMemoryEntities(id, { signalErrors: true });
  return React.createElement('div', {
    id: 'probe',
    'data-loading': String(m.loading),
    'data-error': String(m.error),
    'data-partial': String(m.partial),
    'data-wm-status': m.layerStatus.wm,
    'data-swm-status': m.layerStatus.swm,
    'data-vm-status': m.layerStatus.vm,
    'data-wm': String(m.counts.wm),
    'data-vm': String(m.counts.vm),
    'data-total': String(m.counts.total),
  });
}

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

describe('useMemoryEntities — partial layer failure', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as any).EventSource = MockEventSource;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    // WM (/assertion/) and VM (the exclusion query) succeed; the SWM
    // query (ends in /_shared_memory) returns a 500.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const { sparql = '', contextGraphId = 'cg' } =
        JSON.parse(String(init?.body ?? '{}')) as { sparql?: string; contextGraphId?: string };
      // Robust layer discriminators: every query references both
      // "/assertion/" and "/_shared_memory" (inside FILTER negations),
      // so match on tokens unique to each — `_verified_memory_meta`
      // only appears in the VM query, `STRENDS` only in the SWM query.
      const isVm = sparql.includes('_verified_memory_meta');
      const isSwm = !isVm && sparql.includes('STRENDS');
      const isWm = !isVm && !isSwm;
      if (isSwm) return { ok: false, status: 500, json: async () => ({}) } as Response;
      if (isWm) {
        return { ok: true, json: async () => ({ result: { bindings: [
          triple(`urn:${contextGraphId}:wm-1`, `did:dkg:context-graph:${contextGraphId}/n/assertion/a/x-1`),
          triple(`urn:${contextGraphId}:wm-2`, `did:dkg:context-graph:${contextGraphId}/n/assertion/a/x-2`),
        ] } }) } as Response;
      }
      // VM
      return { ok: true, json: async () => ({ result: { bindings: [
        triple(`urn:${contextGraphId}:vm-1`, `did:dkg:context-graph:${contextGraphId}`),
      ] } }) } as Response;
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps readable layers, sets partial (not error) when one layer fails', async () => {
    await act(async () => { root.render(React.createElement(Probe, { id: 'cg-partial' })); });
    await flush();

    const el = container.querySelector('#probe')!;
    expect(el.getAttribute('data-loading')).toBe('false');
    // One layer (SWM) failed → partial, NOT a hard error.
    expect(el.getAttribute('data-error')).toBe('null');
    expect(el.getAttribute('data-partial')).toBe('true');
    expect(el.getAttribute('data-wm-status')).toBe('ok');
    expect(el.getAttribute('data-swm-status')).toBe('error');
    expect(el.getAttribute('data-vm-status')).toBe('ok');
    // WM + VM still populated despite SWM's 500.
    expect(el.getAttribute('data-wm')).toBe('2');
    expect(el.getAttribute('data-vm')).toBe('1');
    expect(Number(el.getAttribute('data-total'))).toBeGreaterThan(0);
  });
});
