// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useTabsStore } from '../src/ui/stores/tabs.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const loads = vi.hoisted(() => ({ project: 0, layer: 0, stack: 0 }));
const projectGate = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
});
vi.mock('../src/ui/api.js', () => ({ authHeaders: () => ({}), fileUrl: () => '' }));
vi.mock('../src/ui/components/chat/MarkdownMessage.js', () => ({ MarkdownMessage: () => null }));
vi.mock('../src/ui/views/DashboardView.js', () => ({ DashboardView: () => React.createElement('div', null, 'Dashboard ready') }));
vi.mock('../src/ui/views/ContextGraphPrimerView.js', () => ({ ContextGraphPrimerView: () => null }));
vi.mock('../src/ui/views/ProjectView.js', async () => {
  loads.project++;
  await projectGate.promise;
  return { ProjectView: ({ contextGraphId }: { contextGraphId: string }) => {
    const [clicks, setClicks] = React.useState(0);
    return React.createElement('button', { id: 'project', onClick: () => setClicks(clicks + 1) }, `${contextGraphId}:${clicks}`);
  } };
});
vi.mock('../src/ui/views/MemoryLayerView.js', () => {
  loads.layer++;
  return { MemoryLayerView: ({ layer, contextGraphId }: { layer: string; contextGraphId: string }) => {
    const [clicks, setClicks] = React.useState(0);
    return React.createElement('button', { id: 'layer', onClick: () => setClicks(clicks + 1) }, `${layer}:${contextGraphId}:${clicks}`);
  } };
});
vi.mock('../src/ui/views/MemoryStackView.js', () => {
  loads.stack++;
  return { MemoryStackView: () => React.createElement('div', { id: 'stack' }, 'Memory stack ready') };
});

const { PanelCenter } = await import('../src/ui/components/Shell/PanelCenter.js');

it('loads views on demand while preserving tab selection and mounted view state', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  useTabsStore.setState({ tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }], activeTabId: 'dashboard' });
  const open = (id: string) => act(async () => {
    useTabsStore.getState().openTab({ id, label: id, closable: true });
  });
  try {
    await act(async () => root.render(React.createElement(PanelCenter)));
    expect(container.textContent).toContain('Dashboard ready');
    expect(loads).toEqual({ project: 0, layer: 0, stack: 0 });

    await open('project:first');
    expect(container.textContent).toContain('Loading project...');
    await vi.waitFor(() => expect(loads.project).toBe(1));
    // The shell stays interactive during the first chunk load. Resolving it
    // after navigating away must not restore the old selected tab.
    await act(async () => container.querySelector<HTMLButtonElement>('.v10-center-tab')!.click());
    await act(async () => projectGate.resolve());
    expect(useTabsStore.getState().activeTabId).toBe('dashboard');
    expect(container.querySelector('#project')).toBeNull();

    await open('project:first');
    await act(async () => container.querySelector<HTMLButtonElement>('#project')!.click());
    await open('project:second');
    expect(container.querySelector('#project')?.textContent).toBe('second:1');
    expect(loads.project).toBe(1);

    await open('wm:first');
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(container.querySelector('#layer')?.textContent).toBe('wm:first:0');
    await act(async () => container.querySelector<HTMLButtonElement>('#layer')!.click());
    await open('swm:second');
    expect(container.querySelector('#layer')?.textContent).toBe('swm:second:1');
    await open('vm:third');
    expect(container.querySelector('#layer')?.textContent).toBe('vm:third:1');
    expect(loads.layer).toBe(1);

    await open('memory-stack');
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(container.querySelector('#stack')?.textContent).toBe('Memory stack ready');
    expect(loads.stack).toBe(1);
    await act(async () => useTabsStore.getState().closeTab('memory-stack'));
    expect(useTabsStore.getState().activeTabId).toBe('vm:third');
    expect(container.querySelector('#layer')?.textContent).toBe('vm:third:0');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
