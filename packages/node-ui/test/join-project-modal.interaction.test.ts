// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const {
  fetchContextGraphsMock,
  subscribeToContextGraphMock,
  signJoinRequestMock,
  submitJoinRequestMock,
  fetchCurrentAgentMock,
  connectToPeerWithTimeoutMock,
  connectToPeerIdWithTimeoutMock,
} = vi.hoisted(() => ({
  fetchContextGraphsMock: vi.fn(),
  subscribeToContextGraphMock: vi.fn(),
  signJoinRequestMock: vi.fn(),
  submitJoinRequestMock: vi.fn(),
  fetchCurrentAgentMock: vi.fn(),
  connectToPeerWithTimeoutMock: vi.fn(),
  connectToPeerIdWithTimeoutMock: vi.fn(),
}));

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    fetchContextGraphs: fetchContextGraphsMock,
    subscribeToContextGraph: subscribeToContextGraphMock,
    signJoinRequest: signJoinRequestMock,
    submitJoinRequest: submitJoinRequestMock,
    fetchCurrentAgent: fetchCurrentAgentMock,
    connectToPeerWithTimeout: connectToPeerWithTimeoutMock,
    connectToPeerIdWithTimeout: connectToPeerIdWithTimeoutMock,
  };
});

vi.mock('../src/ui/components/Workspace/WireWorkspacePanel.js', () => ({
  WireWorkspacePanel: ({ contextGraphId }: { contextGraphId: string }) =>
    React.createElement('div', { 'data-testid': 'wire-workspace' }, contextGraphId),
}));

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('JoinProjectModal public subscription interaction', () => {
  beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    (globalThis as any).EventSource = class {
      constructor(_url: string) {}
      addEventListener() {}
      removeEventListener() {}
      close() {}
      onopen = null;
      onmessage = null;
      onerror = null;
    };

    const { useProjectsStore } = await import('../src/ui/stores/projects.js');
    const { useTabsStore } = await import('../src/ui/stores/tabs.js');
    useProjectsStore.setState({
      contextGraphs: [{
        id: 'open-project',
        name: 'Open Project',
        accessPolicy: 'public',
        subscribed: true,
        synced: false,
      }],
      loading: false,
      activeProjectId: null,
    });
    useTabsStore.setState({
      tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }],
      activeTabId: 'dashboard',
    });

    subscribeToContextGraphMock.mockResolvedValue({
      subscribed: 'open-project',
      syncMode: 'on-demand',
      catchup: { status: 'queued', jobId: 'catchup-1' },
    });
    fetchContextGraphsMock.mockResolvedValue({
      contextGraphs: [{
        id: 'open-project',
        name: 'Open Project',
        accessPolicy: 'public',
        subscribed: true,
        synced: false,
      }],
    });
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }
  });

  async function renderModal(initialContextGraphId: string) {
    const { JoinProjectModal } = await import('../src/ui/components/Modals/JoinProjectModal.js');
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);

    await act(async () => {
      root.render(React.createElement(JoinProjectModal, {
        open: true,
        onClose,
        initialContextGraphId,
      }));
    });
    await flush();
    return { container, onClose };
  }

  it.each([
    { subscribed: false, caseName: 'starts a first subscription' },
    { subscribed: true, caseName: 'retries catch-up for a subscribed-but-unsynced graph' },
  ])('$caseName through the rendered public modal path', async ({ subscribed }) => {
    const { useProjectsStore } = await import('../src/ui/stores/projects.js');
    const { useTabsStore } = await import('../src/ui/stores/tabs.js');
    const publicGraph = {
      id: 'open-project',
      name: 'Open Project',
      accessPolicy: 'public',
      subscribed,
      synced: false,
    };
    useProjectsStore.setState({ contextGraphs: [publicGraph] });
    fetchContextGraphsMock.mockResolvedValue({ contextGraphs: [publicGraph] });
    const { container, onClose } = await renderModal('open-project');

    const primary = container.querySelector('.v10-modal-btn.primary') as HTMLButtonElement;
    expect(primary.textContent).toBe('Subscribe');

    await act(async () => { primary.click(); });
    await flush();

    expect(subscribeToContextGraphMock).toHaveBeenCalledWith('open-project', {
      syncMode: 'on-demand',
    });
    expect(fetchContextGraphsMock).toHaveBeenCalled();
    expect(signJoinRequestMock).not.toHaveBeenCalled();
    expect(submitJoinRequestMock).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().activeProjectId).toBe('open-project');
    expect(useTabsStore.getState()).toMatchObject({ activeTabId: 'project:open-project' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dials a curator supplied with a public invite before queuing subscription catch-up', async () => {
    const curatorPeerId = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
    connectToPeerIdWithTimeoutMock.mockResolvedValue(undefined);
    const { container } = await renderModal(`open-project\n${curatorPeerId}`);

    const primary = container.querySelector('.v10-modal-btn.primary') as HTMLButtonElement;
    await act(async () => { primary.click(); });
    await flush();

    expect(connectToPeerIdWithTimeoutMock).toHaveBeenCalledWith(curatorPeerId);
    expect(subscribeToContextGraphMock).toHaveBeenCalledWith('open-project', {
      syncMode: 'on-demand',
    });
    expect(connectToPeerIdWithTimeoutMock.mock.invocationCallOrder[0]).toBeLessThan(
      subscribeToContextGraphMock.mock.invocationCallOrder[0],
    );
    expect(signJoinRequestMock).not.toHaveBeenCalled();
    expect(submitJoinRequestMock).not.toHaveBeenCalled();
  });

  it('makes restart-durable synchronization an explicit public-graph choice', async () => {
    const { container } = await renderModal('open-project');
    const keepSynced = container.querySelector(
      'input[aria-label="Keep this Context Graph synchronized after restart"]',
    ) as HTMLInputElement;
    expect(keepSynced.checked).toBe(false);

    await act(async () => { keepSynced.click(); });
    const primary = container.querySelector('.v10-modal-btn.primary') as HTMLButtonElement;
    await act(async () => { primary.click(); });
    await flush();

    expect(subscribeToContextGraphMock).toHaveBeenCalledWith('open-project', {
      syncMode: 'always-on',
    });
  });
});
