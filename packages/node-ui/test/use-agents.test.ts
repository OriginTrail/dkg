// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeQuery } from '../src/ui/api.js';
import { useAgents } from '../src/ui/hooks/useAgents.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/ui/api.js', () => ({
  executeQuery: vi.fn(async () => ({ result: { bindings: [] } })),
}));

describe('useAgents query boundary', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(executeQuery).mockClear();
    vi.mocked(executeQuery).mockResolvedValue({ result: { bindings: [] } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Probe({ contextGraphId }: { contextGraphId: string }) {
    useAgents(contextGraphId);
    return null;
  }

  it('keeps a hostile context graph id inside one literal at the executeQuery sink', async () => {
    const contextGraphId = ['cg-', '\\', '"', '\n', '") } UNION { ?s ?p ?o } #'].join('');
    const prefix = `did:dkg:context-graph:${contextGraphId}/meta`;
    const expectedFilter = `FILTER(strstarts(str(?g), ${JSON.stringify(prefix)}))`;

    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(executeQuery).toHaveBeenCalledOnce();
    const [sparql, options] = vi.mocked(executeQuery).mock.calls[0];
    expect(sparql).toContain(expectedFilter);
    expect(sparql).not.toContain(contextGraphId);
    expect(options).toEqual({ contextGraphId });
  });
});
