// @vitest-environment happy-dom
//
// Covers PR2 drag-and-drop: react-dropzone wraps `.v10-local-agent-messages`,
// forwards dropped files to `onAddAttachments` only when a project is active,
// and renders accept/refuse overlays gated on `activeProjectId`.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Local bridge',
    connectSupported: true,
    chatSupported: true,
    chatReady: true,
    chatAttachments: true,
    persistentChat: true,
    bridgeOnline: true,
    bridgeStatusLabel: 'Connected',
    configured: true,
    detected: true,
    status: 'connected',
    statusLabel: 'Connected',
    detail: 'ready',
    target: 'local',
    ...overrides,
  } as any;
}

function noop() {}

async function renderTab(
  overrides: Record<string, unknown>,
): Promise<{ container: HTMLDivElement; messagesRegion: HTMLElement; unmount: () => Promise<void> }> {
  const { ConnectedAgentsTab } = await import('../src/ui/components/Shell/PanelRight.js');

  const props: Record<string, unknown> = {
    integrations: [integration()],
    selectedIntegrationId: 'openclaw',
    selectedIntegration: integration(),
    selectedSessionId: 'openclaw:default',
    selectedHasConversation: false,
    selectedIntegrationHasAnyConversation: false,
    onSelectIntegration: noop,
    onConnectIntegration: noop,
    onDisconnectIntegration: noop,
    onRefreshIntegration: noop,
    connectBusyId: null,
    refreshBusyId: null,
    connectNotice: null,
    connectError: null,
    localMessages: [],
    localHistoryLoaded: true,
    localChatEndRef: { current: null },
    localInput: '',
    onLocalInputChange: noop,
    onSendLocalMessage: noop,
    onStopLocalStream: noop,
    localSending: false,
    activeProjectId: 'testing',
    availableProjects: [{ id: 'testing', name: 'Testing' }],
    projectsLoading: false,
    onSelectProject: noop,
    attachments: [],
    onAddAttachments: noop,
    onRemoveAttachment: noop,
    ...overrides,
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(ConnectedAgentsTab, props as any));
  });

  const messagesRegion = container.querySelector('.v10-local-agent-messages') as HTMLElement | null;
  if (!messagesRegion) {
    throw new Error('Expected .v10-local-agent-messages region to be rendered');
  }

  return {
    container,
    messagesRegion,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

interface FakeDataTransfer {
  files: File[];
  items: Array<{ kind: 'file'; type: string; getAsFile: () => File }>;
  types: string[];
  getData?: (key: string) => string;
}

function buildDataTransfer(files: File[]): FakeDataTransfer {
  return {
    files,
    items: files.map((file) => ({
      kind: 'file' as const,
      type: file.type,
      getAsFile: () => file,
    })),
    types: ['Files'],
    getData: () => '',
  };
}

async function dispatchDrop(
  region: HTMLElement,
  files: File[],
): Promise<void> {
  const dataTransfer = buildDataTransfer(files);

  await act(async () => {
    const dragenter = new Event('dragenter', { bubbles: true, cancelable: true });
    Object.defineProperty(dragenter, 'dataTransfer', { value: dataTransfer });
    region.dispatchEvent(dragenter);
  });

  await act(async () => {
    const dragover = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(dragover, 'dataTransfer', { value: dataTransfer });
    region.dispatchEvent(dragover);
  });

  await act(async () => {
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    region.dispatchEvent(drop);
    // react-dropzone resolves its file-collection promise asynchronously.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  });
}

async function dispatchDragEnter(region: HTMLElement, files: File[]): Promise<void> {
  const dataTransfer = buildDataTransfer(files);
  await act(async () => {
    const dragenter = new Event('dragenter', { bubbles: true, cancelable: true });
    Object.defineProperty(dragenter, 'dataTransfer', { value: dataTransfer });
    region.dispatchEvent(dragenter);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  });
}

describe('Drop zone over the messages region', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards dropped files to onAddAttachments when a project is active', async () => {
    const onAddAttachments = vi.fn();
    const file = new File(['hello'], 'spec.md', { type: 'text/markdown' });
    const { messagesRegion, unmount } = await renderTab({
      activeProjectId: 'testing',
      onAddAttachments,
    });

    await dispatchDrop(messagesRegion, [file]);

    expect(onAddAttachments).toHaveBeenCalledTimes(1);
    const [calledWith] = onAddAttachments.mock.calls[0]!;
    expect(Array.isArray(calledWith) ? calledWith.length : 0).toBe(1);
    expect(calledWith[0].name).toBe('spec.md');
    await unmount();
  });

  it('does NOT forward dropped files when no project is active', async () => {
    const onAddAttachments = vi.fn();
    const file = new File(['hello'], 'spec.md', { type: 'text/markdown' });
    const { messagesRegion, unmount } = await renderTab({
      activeProjectId: null,
      onAddAttachments,
    });

    await dispatchDrop(messagesRegion, [file]);

    expect(onAddAttachments).not.toHaveBeenCalled();
    await unmount();
  });

  it('does NOT forward dropped files when the agent is currently sending', async () => {
    const onAddAttachments = vi.fn();
    const file = new File(['hello'], 'spec.md', { type: 'text/markdown' });
    const { messagesRegion, unmount } = await renderTab({
      activeProjectId: 'testing',
      localSending: true,
      onAddAttachments,
    });

    await dispatchDrop(messagesRegion, [file]);

    expect(onAddAttachments).not.toHaveBeenCalled();
    await unmount();
  });

  it('does NOT forward dropped files when the integration does not support attachments', async () => {
    const onAddAttachments = vi.fn();
    const file = new File(['hello'], 'spec.md', { type: 'text/markdown' });
    const noAttach = integration({ chatAttachments: false });
    const { messagesRegion, unmount } = await renderTab({
      integrations: [noAttach],
      selectedIntegration: noAttach,
      activeProjectId: 'testing',
      onAddAttachments,
    });

    await dispatchDrop(messagesRegion, [file]);

    expect(onAddAttachments).not.toHaveBeenCalled();
    await unmount();
  });

  it('renders the accept overlay on dragenter when a project is active', async () => {
    const file = new File(['hello'], 'spec.md', { type: 'text/markdown' });
    const { container, messagesRegion, unmount } = await renderTab({
      activeProjectId: 'testing',
    });

    expect(container.querySelector('.v10-drop-overlay')).toBeNull();
    await dispatchDragEnter(messagesRegion, [file]);

    const overlay = container.querySelector('.v10-drop-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay!.classList.contains('active')).toBe(true);
    expect(overlay!.classList.contains('accept')).toBe(true);
    expect(overlay!.classList.contains('refuse')).toBe(false);
    expect(overlay!.textContent ?? '').toContain('Drop files to attach');
    await unmount();
  });

  it('renders the refuse overlay on dragenter when no project is active', async () => {
    const file = new File(['hello'], 'spec.md', { type: 'text/markdown' });
    const { container, messagesRegion, unmount } = await renderTab({
      activeProjectId: null,
    });

    await dispatchDragEnter(messagesRegion, [file]);

    const overlay = container.querySelector('.v10-drop-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay!.classList.contains('refuse')).toBe(true);
    expect(overlay!.classList.contains('accept')).toBe(false);
    expect(overlay!.textContent ?? '').toMatch(/choose a project/i);
    await unmount();
  });
});
