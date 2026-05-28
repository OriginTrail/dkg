// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectProfileContext, type ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// fetchSubGraphs is the daemon-backed source that Issue G's fix
// gates on. Default mock resolves with empty cards (the
// success-empty branch); individual tests override per-call.
const fetchSubGraphsMock = vi.fn();

vi.mock('../src/ui/api.js', () => ({
  fetchSubGraphs: (...args: any[]) => fetchSubGraphsMock(...args),
  executeQuery: vi.fn(async () => ({ result: { bindings: [] } })),
}));

// The grid renders mini RdfGraphs per card; the lazy import would
// otherwise stall the test. Stub it out — only the empty/error
// branches matter for this file.
vi.mock('@origintrail-official/dkg-graph-viz/react', async () => {
  const React = await import('react');
  return {
    RdfGraph() {
      return React.createElement('div', { 'data-testid': 'rdf-graph' });
    },
  };
});

import { SubGraphOverviewGrid } from '../src/ui/views/project/components.js';

const profile: ProjectProfile = {
  contextGraphId: 'cg-test',
  displayName: 'Test',
  primaryColor: '#64748b',
  accentColor: '#38bdf8',
  subGraphs: [],
  typeBindings: [],
  views: [],
  filterChips: [],
  queryCatalogs: [],
  savedQueries: [],
  loading: false,
  forSubGraph: (slug: string) => ({ slug, displayName: slug, color: '#38bdf8', icon: '#', rank: 0 }),
  forType: () => ({}) as any,
  view: () => undefined,
  chipsFor: () => [],
  savedQueryCatalogsFor: () => [],
  savedQueriesFor: () => [],
};

const memory = {
  entities: new Map(),
  entityList: [],
  allTriples: [],
  graphTriples: [],
  trustMap: new Map(),
  counts: { wm: 0, swm: 0, vm: 0, total: 0 },
  loading: false,
  error: null,
  partial: false,
  layerStatus: { wm: 'ok' as const, swm: 'ok' as const, vm: 'ok' as const },
  refresh: vi.fn(),
} as any;

async function flush(): Promise<void> {
  // Two microtask drains — one for the promise the effect kicks
  // off, one for the setState in the resolver/finally.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe('SubGraphOverviewGrid — fetch failure state (S3 Codex sweep 3 Issue G)', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchSubGraphsMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    return act(async () => {
      root.render(
        React.createElement(ProjectProfileContext.Provider, { value: profile },
          React.createElement(SubGraphOverviewGrid, {
            contextGraphId: 'cg-test',
            memory,
            onNodeClick: vi.fn(),
            onSelectSubGraph: vi.fn(),
          })),
      );
    });
  }

  // Issue G load-bearing case: a transient `fetchSubGraphs` error
  // used to render the success-empty teaching state ("No subgraphs
  // in this Context Graph yet" + View root CTA) because the catch
  // was silent. That's authoritative-looking but wrong — the user
  // doesn't know yet whether the CG has sub-graphs or not. The new
  // error branch shows a distinct "Couldn't load subgraphs" state.
  it('renders the error state — NOT the teaching empty — when fetchSubGraphs rejects', async () => {
    fetchSubGraphsMock.mockRejectedValueOnce(new Error('network timeout'));
    await render();
    await flush();

    const empty = container.querySelector('.v10-empty-state');
    expect(empty).toBeTruthy();
    const title = empty!.querySelector('.v10-empty-state-title')?.textContent ?? '';
    expect(title).toBe("Couldn't load subgraphs.");
    // Must NOT be the success-empty teaching copy.
    expect(title).not.toContain('No subgraphs in this Context Graph yet');
    // Must NOT show the View root CTA (the user has no way of
    // knowing whether root is the right place to look until the
    // sub-graph list actually loads).
    const action = empty!.querySelector('.v10-empty-state-action');
    expect(action).toBeNull();
    // Error tone for the data-tone attribute / styling consumers.
    expect(empty!.getAttribute('data-tone')).toBe('danger');
  });

  // Regression guard for the other direction — the new error branch
  // must NOT swallow the success-empty teaching state when the
  // daemon legitimately returns an empty list.
  it('still renders the teaching empty state when fetchSubGraphs resolves with []', async () => {
    fetchSubGraphsMock.mockResolvedValueOnce({ subGraphs: [] });
    await render();
    await flush();

    const empty = container.querySelector('.v10-empty-state');
    expect(empty).toBeTruthy();
    const title = empty!.querySelector('.v10-empty-state-title')?.textContent ?? '';
    expect(title).toBe('No subgraphs in this Context Graph yet.');
    // The teaching state offers the View root action.
    const action = empty!.querySelector('.v10-empty-state-action');
    expect(action).toBeTruthy();
    expect(action!.textContent).toContain('View root');
    // Neutral tone, not danger.
    expect(empty!.getAttribute('data-tone')).toBe('neutral');
  });
});
