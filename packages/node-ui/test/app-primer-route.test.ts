// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabsStore } from '../src/ui/stores/tabs.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: {
    fetchStatus: vi.fn(async () => ({ synced: true, peers: 0 })),
  },
}));

vi.mock('../src/ui/api.js', () => ({
  authHeaders: () => ({}),
  fileUrl: () => '',
}));

vi.mock('../src/ui/components/Shell/Header.js', () => ({
  Header: () => React.createElement('header', { 'data-testid': 'header' }),
}));

vi.mock('../src/ui/components/Shell/PanelLeft.js', () => ({
  PanelLeft: () => React.createElement('aside', { 'data-testid': 'left-panel' }),
}));

vi.mock('../src/ui/components/Shell/PanelBottom.js', () => ({
  PanelBottom: () => React.createElement('footer', { 'data-testid': 'bottom-panel' }),
}));

vi.mock('../src/ui/components/Shell/PanelRight.js', () => ({
  PanelRight: () => React.createElement('aside', { 'data-testid': 'right-panel' }),
}));

vi.mock('../src/ui/views/DashboardView.js', () => ({
  DashboardView: () => {
    throw new Error('Dashboard should not mount before primer route activation');
  },
}));

vi.mock('../src/ui/views/ProjectView.js', () => ({
  ProjectView: () => React.createElement('div', { 'data-testid': 'project-view' }),
}));

vi.mock('../src/ui/views/MemoryLayerView.js', () => ({
  MemoryLayerView: () => React.createElement('div', { 'data-testid': 'memory-layer-view' }),
}));

vi.mock('../src/ui/views/MemoryStackView.js', () => ({
  MemoryStackView: () => React.createElement('div', { 'data-testid': 'memory-stack-view' }),
}));

vi.mock('../src/ui/views/ContextGraphPrimerView.js', () => ({
  ContextGraphPrimerView: () => React.createElement('div', { 'data-testid': 'primer-view' }, 'Primer'),
}));

const { App } = await import('../src/ui/App.js');

describe('Context Graph primer route', () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    useTabsStore.setState({
      tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }],
      activeTabId: 'dashboard',
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('activates the primer tab before the shell renders the dashboard', async () => {
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing root');
    root = createRoot(container);

    await act(async () => {
      root!.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/context-graph-primer'] },
          React.createElement(App),
        ),
      );
    });

    expect(document.querySelector('[data-testid="primer-view"]')).toBeTruthy();
    expect(useTabsStore.getState().activeTabId).toBe('context-graph-primer');
    expect(useTabsStore.getState().tabs.some(tab => tab.id === 'context-graph-primer')).toBe(true);
  });
});
