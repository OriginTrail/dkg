// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useMemoryEntities } from '../src/ui/hooks/useMemoryEntities.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_NAME = 'http://schema.org/name';
const MENTIONS = 'http://schema.org/mentions';

class MockEventSource {
  static instances: MockEventSource[] = [];
  constructor(readonly url: string) { MockEventSource.instances.push(this); }
  addEventListener() {}
  close() {}
}

function binding(subject: string, predicate: string, object: string, graph: string) {
  return {
    s: { value: subject },
    p: { value: predicate },
    o: { value: object },
    g: { value: graph },
  };
}

function Probe({ id }: { id: string }) {
  const memory = useMemoryEntities(id);
  const labels = memory.entityList.map(e => `${e.uri}=${e.label}`).join('|');
  const targets = memory.entityList
    .flatMap(e => e.connections.map(c => `${c.targetUri}=${c.targetLabel}`))
    .join('|');
  return React.createElement('div', {
    id: 'probe',
    'data-loading': String(memory.loading),
    'data-labels': labels,
    'data-targets': targets,
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useMemoryEntities readable labels', () => {
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
      const graph = `did:dkg:context-graph:${contextGraphId}/notes/assertion/agent/a-1`;
      const extraction = 'urn:dkg:extraction:123e4567-e89b-12d3-a456-426614174000';
      const bindings = isVm || isSwm
        ? []
        : [
            binding(extraction, RDF_TYPE, 'http://schema.org/Thing', graph),
            binding('urn:test:named', RDF_TYPE, 'http://schema.org/Thing', graph),
            binding('urn:test:named', SCHEMA_NAME, 'Friendly title', graph),
            binding('urn:test:source', RDF_TYPE, 'http://schema.org/Thing', graph),
            binding('urn:test:source', MENTIONS, extraction, graph),
            binding('urn:dkg:code:file:demo/project/src/file.ts', RDF_TYPE, 'http://dkg.io/ontology/code/File', graph),
            binding('did:dkg:agent:12D3KooWExample', RDF_TYPE, 'http://schema.org/Person', graph),
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

  it('prefers name triples and does not use raw extraction URNs as primary labels', async () => {
    await act(async () => {
      root.render(React.createElement(Probe, { id: 'cg-labels' }));
    });
    await flush();

    const el = container.querySelector('#probe')!;
    const labels = el.getAttribute('data-labels') ?? '';
    const targets = el.getAttribute('data-targets') ?? '';

    expect(el.getAttribute('data-loading')).toBe('false');
    expect(labels).toContain('urn:test:named=Friendly title');
    expect(labels).toContain('urn:test:source=source');
    expect(labels).toContain('urn:dkg:code:file:demo/project/src/file.ts=file.ts');
    expect(labels).toContain('did:dkg:agent:12D3KooWExample=Person 12D3KooWExample');
    expect(labels).toContain('urn:dkg:extraction:123e4567-e89b-12d3-a456-426614174000=Extraction 123e4567e89b');
    expect(labels).not.toContain('urn:dkg:extraction:123e4567-e89b-12d3-a456-426614174000=urn:dkg:extraction');
    expect(labels).not.toContain('urn:test:source=urn:test:source');
    expect(labels).not.toContain('urn:dkg:code:file:demo/project/src/file.ts=File file.ts');
    expect(labels).not.toContain('did:dkg:agent:12D3KooWExample=did:dkg:agent:12D3KooWExample');
    expect(targets).toContain('urn:dkg:extraction:123e4567-e89b-12d3-a456-426614174000=Extraction 123e4567e89b');
  });
});
