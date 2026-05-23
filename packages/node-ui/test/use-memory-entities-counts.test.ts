// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useMemoryEntities } from '../src/ui/hooks/useMemoryEntities.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const MENTIONS = 'http://schema.org/mentions';

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  constructor(readonly url: string) { MockEventSource.instances.push(this); }
  addEventListener(t: string, l: (e: MessageEvent) => void) {
    const a = this.listeners.get(t) ?? [];
    a.push(l);
    this.listeners.set(t, a);
  }
  close() {}
}

function typeBinding(subject: string, graph: string) {
  return {
    s: { value: subject },
    p: { value: RDF_TYPE },
    o: { value: 'http://schema.org/Thing' },
    g: { value: graph },
  };
}

function uriBinding(subject: string, predicate: string, object: string, graph: string) {
  return {
    s: { value: subject },
    p: { value: predicate },
    o: { value: object },
    g: { value: graph },
  };
}

function Probe({ id }: { id: string }) {
  const memory = useMemoryEntities(id);
  return React.createElement('div', {
    id: 'probe',
    'data-loading': String(memory.loading),
    'data-wm': String(memory.counts.wm),
    'data-swm': String(memory.counts.swm),
    'data-vm': String(memory.counts.vm),
    'data-total': String(memory.counts.total),
    'data-current-layers': memory.entityList.map(e => `${e.uri}:${e.trustLevel}`).join('|'),
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useMemoryEntities canonical layer counts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as any).EventSource = MockEventSource;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const { sparql = '', contextGraphId = 'cg' } =
        JSON.parse(String(init?.body ?? '{}')) as { sparql?: string; contextGraphId?: string };
      const isVm = sparql.includes('_verified_memory_meta');
      const isSwm = !isVm && sparql.includes('STRENDS');
      const graphBase = `did:dkg:context-graph:${contextGraphId}`;
      const bindings = isVm
        ? [
            typeBinding('urn:test:verified', graphBase),
            typeBinding('urn:test:full-pipeline', graphBase),
          ]
        : isSwm
          ? [
              typeBinding('urn:test:promoted', `${graphBase}/notes/_shared_memory`),
              typeBinding('urn:test:full-pipeline', `${graphBase}/notes/_shared_memory`),
            ]
          : [
              typeBinding('urn:test:promoted', `${graphBase}/notes/assertion/agent/a-1`),
              typeBinding('urn:test:full-pipeline', `${graphBase}/notes/assertion/agent/a-1`),
              typeBinding('urn:test:draft', `${graphBase}/notes/assertion/agent/a-2`),
              typeBinding('urn:test:draft', `${graphBase}/docs/assertion/agent/a-3`),
              uriBinding('urn:test:draft', MENTIONS, 'urn:test:object-only', `${graphBase}/docs/assertion/agent/a-3`),
            ];
      return {
        ok: true,
        json: async () => ({ result: { bindings } }),
      } as Response;
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('counts each visible entity once in its current highest layer', async () => {
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-counts' }));
    });
    await flush();

    const el = container.querySelector('#probe')!;
    expect(el.getAttribute('data-loading')).toBe('false');
    expect(el.getAttribute('data-wm')).toBe('1');
    expect(el.getAttribute('data-swm')).toBe('1');
    expect(el.getAttribute('data-vm')).toBe('2');
    expect(el.getAttribute('data-total')).toBe('4');
    expect(el.getAttribute('data-current-layers')).toContain('urn:test:promoted:shared');
    expect(el.getAttribute('data-current-layers')).toContain('urn:test:full-pipeline:verified');
    expect(el.getAttribute('data-current-layers')).not.toContain('urn:test:object-only');
  });
});
