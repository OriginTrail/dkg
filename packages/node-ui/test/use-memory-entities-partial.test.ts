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
    'data-swm': String(m.counts.swm),
    'data-vm': String(m.counts.vm),
    'data-total': String(m.counts.total),
  });
}

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

describe('useMemoryEntities — partial layer failure', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scenario: 'swm-error' | 'swm-limit';

  beforeEach(() => {
    scenario = 'swm-error';
    MockEventSource.instances = [];
    (globalThis as any).EventSource = MockEventSource;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const { contextGraphId = 'cg' } =
        JSON.parse(String(init?.body ?? '{}')) as { contextGraphId?: string };
      return { ok: true, json: async () => ({ contextGraphId, layers: {
        wm: { ok: true, truncated: false, bindings: [
          triple(`urn:${contextGraphId}:wm-1`, `did:dkg:context-graph:${contextGraphId}/n/assertion/a/x-1`),
          triple(`urn:${contextGraphId}:wm-2`, `did:dkg:context-graph:${contextGraphId}/n/assertion/a/x-2`),
        ] },
        swm: scenario === 'swm-error'
          ? { ok: false, truncated: false, bindings: [] }
          : { ok: true, truncated: true, bindings: [
              triple(`urn:${contextGraphId}:swm-limited`, `did:dkg:context-graph:${contextGraphId}/n/_shared_memory`),
            ] },
        vm: { ok: true, truncated: false, bindings: [
          triple(`urn:${contextGraphId}:vm-1`, `did:dkg:context-graph:${contextGraphId}`),
        ] },
      } }) } as Response;
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

  it('marks counts partial when a successful layer reaches its query limit', async () => {
    scenario = 'swm-limit';

    await act(async () => { root.render(React.createElement(Probe, { id: 'cg-limited' })); });
    await flush();

    const el = container.querySelector('#probe')!;
    expect(el.getAttribute('data-loading')).toBe('false');
    expect(el.getAttribute('data-error')).toBe('null');
    expect(el.getAttribute('data-partial')).toBe('true');
    expect(el.getAttribute('data-wm-status')).toBe('ok');
    expect(el.getAttribute('data-swm-status')).toBe('ok');
    expect(el.getAttribute('data-vm-status')).toBe('ok');
    expect(el.getAttribute('data-swm')).toBe('1');

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
