// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listAssertions: vi.fn(),
  promoteAssertion: vi.fn(),
  publishSharedMemory: vi.fn(),
}));

vi.mock('../src/ui/api.js', () => ({
  listJoinRequests: vi.fn(async () => ({ requests: [] })),
  approveJoinRequest: vi.fn(),
  rejectJoinRequest: vi.fn(),
  listParticipants: vi.fn(async () => ({ allowedAgents: [] })),
  listAssertions: apiMocks.listAssertions,
  promoteAssertion: apiMocks.promoteAssertion,
  publishSharedMemory: apiMocks.publishSharedMemory,
  executeQuery: vi.fn(),
  writeProfileQueryCatalog: vi.fn(),
  fetchSubGraphs: vi.fn(async () => ({ subGraphs: [] })),
}));

const {
  EmptyState,
  StatStrip,
} = await import('../src/ui/components/ContextGraphPrimitives.js');

const {
  AssertionsList,
  LayerGraphPanel,
  VerifiedMemoryHeroBanner,
} = await import('../src/ui/views/project/components.js');

const {
  ActivityFeed,
} = await import('../src/ui/components/ActivityFeed.js');

async function render(node: React.ReactElement): Promise<{
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(node);
  });

  return {
    container,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function waitForText(container: HTMLElement, text: string): Promise<void> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 1000) {
    last = container.textContent ?? '';
    if (last.includes(text)) return;
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Timed out waiting for text "${text}" in "${last}"`);
}

describe('Context Graph shared empty/stat patterns', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders EmptyState without requiring an action', async () => {
    const { container, unmount } = await render(
      React.createElement(EmptyState, {
        icon: 'i',
        title: 'No entities yet',
        description: 'Import data to populate this layer.',
        tone: 'wm',
      }),
    );

    expect(container.querySelector('.v10-empty-state')).toBeTruthy();
    expect(container.querySelector('.v10-empty-state-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.v10-empty-state-action')).toBeNull();
    expect(container.textContent).toContain('No entities yet');
    expect(container.textContent).toContain('Import data to populate this layer.');

    await unmount();
  });

  it('renders StatStrip cells with layer tone and labelled values', async () => {
    const { container, unmount } = await render(
      React.createElement(StatStrip, {
        layer: 'vm',
        items: [
          { id: 'assets', value: 2, label: 'Knowledge Assets' },
          { id: 'triples', value: '1,234', label: 'Verified Triples' },
        ],
      }),
    );

    expect(container.querySelector('.v10-stat-strip')?.getAttribute('data-layer')).toBe('vm');
    expect(Array.from(container.querySelectorAll('.v10-stat-strip-value')).map(el => el.textContent))
      .toEqual(['2', '1,234']);
    expect(container.textContent).toContain('Knowledge Assets');
    expect(container.textContent).toContain('Verified Triples');

    await unmount();
  });

  it('keeps compact StatStrip labels before values in DOM reading order', async () => {
    const { container, unmount } = await render(
      React.createElement(StatStrip, {
        compact: true,
        items: [
          { id: 'entities', value: 12, label: 'Entities' },
        ],
      }),
    );

    const cell = container.querySelector('.v10-stat-strip-cell');
    expect(cell?.children[0]?.className).toBe('v10-stat-strip-label');
    expect(cell?.children[0]?.textContent).toBe('Entities');
    expect(cell?.children[1]?.className).toBe('v10-stat-strip-value');
    expect(cell?.children[1]?.textContent).toBe('12');

    await unmount();
  });

  it('uses the shared empty pattern for empty activity feeds', async () => {
    const { container, unmount } = await render(
      React.createElement(ActivityFeed, {
        entities: [],
        onSelectEntity: vi.fn(),
        emptyHint: 'No recent updates yet.',
      }),
    );

    expect(container.querySelector('.v10-activity-feed-empty .v10-empty-state')).toBeTruthy();
    expect(container.textContent).toContain('No recent updates yet.');

    await unmount();
  });

  it('shows the explained interim empty state for SWM assertions', async () => {
    apiMocks.listAssertions.mockResolvedValueOnce([]);
    const { container, unmount } = await render(
      React.createElement(AssertionsList, {
        contextGraphId: 'cg-test',
        layer: 'swm',
        onComplete: vi.fn(),
      }),
    );

    await waitForText(container, 'No Shared Working Memory assertions listed yet.');
    expect(container.querySelector('.v10-layer-empty-shell .v10-empty-state')).toBeTruthy();
    expect(container.textContent).toContain('Promoted assertion contents are available as Shared Working Memory entities.');
    expect(container.textContent).not.toContain('No assertions in this layer');

    await unmount();
  });

  it('keeps graph and VM empty states inside the shared content gutter', async () => {
    const { container, unmount } = await render(
      React.createElement(React.Fragment, null,
        React.createElement(LayerGraphPanel, {
          layer: 'wm',
          triples: [],
          onNodeClick: vi.fn(),
          contextGraphId: 'cg-test',
        }),
        React.createElement('div', { className: 'v10-layer-expand-body entities-tab' },
          React.createElement(VerifiedMemoryHeroBanner, {
            entities: [],
            tripleCount: 0,
            contextGraphId: 'cg-test',
          }),
        ),
      ),
    );

    expect(container.querySelector('.v10-graph-view .v10-layer-empty-shell .v10-empty-state')).toBeTruthy();
    expect(container.querySelector('.v10-layer-expand-body.entities-tab > .v10-vm-hero')).toBeTruthy();
    expect(container.textContent).toContain('No triples in Working Memory');
    expect(container.textContent).toContain('No Knowledge Assets yet.');

    await unmount();
  });

  it('keeps WM assertions empty copy separate from the SWM backend-gated copy', async () => {
    apiMocks.listAssertions.mockResolvedValueOnce([]);
    const { container, unmount } = await render(
      React.createElement(AssertionsList, {
        contextGraphId: 'cg-test',
        layer: 'wm',
        onComplete: vi.fn(),
      }),
    );

    await waitForText(container, 'No Working Memory assertions yet.');
    expect(container.textContent).toContain('Create or import data to stage assertions in Working Memory.');
    expect(container.textContent).not.toContain('Promoted assertion contents are available');

    await unmount();
  });

  it('renders assertion rows when SWM assertions become listable', async () => {
    apiMocks.listAssertions.mockResolvedValueOnce([
      { name: 'turn-anno-test', tripleCount: 3 },
    ]);
    const { container, unmount } = await render(
      React.createElement(AssertionsList, {
        contextGraphId: 'cg-test',
        layer: 'swm',
        onComplete: vi.fn(),
      }),
    );

    await waitForText(container, 'turn-anno-test');
    expect(container.textContent).toContain('3 triples');
    expect(container.textContent).not.toContain('No Shared Working Memory assertions listed yet.');

    await unmount();
  });
});
