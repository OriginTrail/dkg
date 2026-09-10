// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useTabsStore } from '../src/ui/stores/tabs.js';
import { createRecoverableLazyView } from '../src/ui/components/Shell/RecoverableLazyView.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const chunkFailure = vi.hoisted(() => new TypeError('Failed to fetch dynamically imported module'));
vi.mock('../src/ui/api.js', () => ({ authHeaders: () => ({}), fileUrl: () => '' }));
vi.mock('../src/ui/components/chat/MarkdownMessage.js', () => ({ MarkdownMessage: () => null }));
vi.mock('../src/ui/views/DashboardView.js', () => ({ DashboardView: () => React.createElement('div', null, 'Dashboard ready') }));
vi.mock('../src/ui/views/ContextGraphPrimerView.js', () => ({ ContextGraphPrimerView: () => null }));
vi.mock('../src/ui/views/ProjectView.js', () => { throw chunkFailure; });
const { PanelCenter } = await import('../src/ui/components/Shell/PanelCenter.js');

it.each((() => {
  const named = Object.assign(new Error('named chunk failure'), { name: 'ChunkLoadError' });
  const coded = Object.assign(new Error('coded chunk failure'), { code: 'CSS_CHUNK_LOAD_FAILED' });
  const message = new TypeError('Importing a module script failed.');
  const cause = new TypeError('Error loading dynamically imported module');
  const nested = Object.assign(new Error('wrapped loader failure'), { cause });
  return [
    { mechanism: 'name', failure: named, reported: named },
    { mechanism: 'code', failure: coded, reported: coded },
    { mechanism: 'alternate message', failure: message, reported: message },
    { mechanism: 'nested cause', failure: nested, reported: cause },
  ];
})())('recovers a chunk-load failure recognized by $mechanism', async ({ failure, reported }) => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const FailingView = createRecoverableLazyView<Record<string, never>>(
    async () => { throw failure; },
    'test view',
  );

  try {
    await act(async () => root.render(React.createElement(FailingView)));
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Reload the page');
    expect(report.mock.calls.some((call) => call.includes(reported))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    report.mockRestore();
  }
});

it('keeps the shell usable after chunk rejection and offers a full reload', async () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  useTabsStore.setState({ tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }], activeTabId: 'dashboard' });
  try {
    await act(async () => root.render(React.createElement(PanelCenter)));
    await act(async () => useTabsStore.getState().openTab({ id: 'project:first', label: 'First project', closable: true }));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(useTabsStore.getState().activeTabId).toBe('project:first');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Reload the page');
    expect(report.mock.calls.some((call) => call.includes(chunkFailure))).toBe(true);
    expect(container.querySelectorAll('.v10-center-tab')).toHaveLength(2);
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(reload).toHaveBeenCalledOnce();
    await act(async () => container.querySelector<HTMLButtonElement>('.v10-center-tab')!.click());
    expect(container.textContent).toContain('Dashboard ready');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // React.lazy caches the rejection. Returning to the failed view must stay
    // recoverable; retrying the same component cannot replace a full reload.
    await act(async () => useTabsStore.getState().setActiveTab('project:first'));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    reload.mockRestore();
    report.mockRestore();
  }
});

it('rethrows an unexpected lazy-module failure to the surrounding error boundary', async () => {
  const unexpected = new ReferenceError('module initialization failed');
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let caught: unknown;

  class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
      return { failed: true };
    }

    componentDidCatch(error: unknown) {
      caught = error;
    }

    render() {
      return this.state.failed
        ? React.createElement('div', { id: 'boundary-error' }, 'View failed')
        : this.props.children;
    }
  }

  const UnexpectedView = createRecoverableLazyView<Record<string, never>>(
    async () => { throw unexpected; },
    'unexpected view',
  );

  try {
    await act(async () => root.render(
      React.createElement(Boundary, null, React.createElement(UnexpectedView)),
    ));
    expect(caught).toBe(unexpected);
    expect(container.querySelector('#boundary-error')?.textContent).toBe('View failed');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    report.mockRestore();
  }
});
