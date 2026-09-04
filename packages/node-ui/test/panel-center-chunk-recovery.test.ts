// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useTabsStore } from '../src/ui/stores/tabs.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../src/ui/api.js', () => ({ authHeaders: () => ({}), fileUrl: () => '' }));
vi.mock('../src/ui/components/chat/MarkdownMessage.js', () => ({ MarkdownMessage: () => null }));
vi.mock('../src/ui/views/DashboardView.js', () => ({ DashboardView: () => React.createElement('div', null, 'Dashboard ready') }));
vi.mock('../src/ui/views/ContextGraphPrimerView.js', () => ({ ContextGraphPrimerView: () => null }));
vi.mock('../src/ui/views/ProjectView.js', () => { throw new Error('Failed to fetch dynamically imported module'); });
const { PanelCenter } = await import('../src/ui/components/Shell/PanelCenter.js');

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
