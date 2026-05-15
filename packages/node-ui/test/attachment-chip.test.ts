// @vitest-environment happy-dom
//
// Covers PR2 compact attachment-chip rendering in `<ConnectedAgentsTab>`:
// `data-status` per state, status label, badge from file extension,
// formatted size, click on `.v10-attachment-chip-remove` → onRemoveAttachment.

import React, { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

async function renderWithAttachments(
  attachments: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
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
    localSending: false,
    activeProjectId: 'testing',
    availableProjects: [{ id: 'testing', name: 'Testing' }],
    projectsLoading: false,
    onSelectProject: noop,
    attachments,
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

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'draft-1',
    file: new File(['hello world'], 'spec.md', { type: 'text/markdown' }),
    contextGraphId: 'testing',
    assertionName: 'spec',
    status: 'queued',
    ...overrides,
  };
}

describe('AttachmentChip rendering', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
  });

  it('renders no chip list when there are no attachments', async () => {
    const { container, unmount } = await renderWithAttachments([]);
    expect(container.querySelector('.v10-attachment-chips')).toBeNull();
    expect(container.querySelector('.v10-attachment-chip')).toBeNull();
    await unmount();
  });

  it('renders a chip in queued state with the correct data-status and label', async () => {
    const { container, unmount } = await renderWithAttachments([draft({ status: 'queued' })]);
    const chip = container.querySelector('.v10-attachment-chip') as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.getAttribute('data-status')).toBe('queued');
    expect(chip.getAttribute('role')).toBe('listitem');
    expect(chip.querySelector('.v10-attachment-chip-status')?.textContent).toBe('Queued');
    expect(chip.querySelector('.v10-attachment-chip-name')?.textContent).toBe('spec.md');
    await unmount();
  });

  it('renders uploading state with "Importing…" label', async () => {
    const { container, unmount } = await renderWithAttachments([draft({ status: 'uploading' })]);
    const chip = container.querySelector('.v10-attachment-chip') as HTMLElement;
    expect(chip.getAttribute('data-status')).toBe('uploading');
    expect(chip.querySelector('.v10-attachment-chip-status')?.textContent).toBe('Importing…');
    await unmount();
  });

  it('renders completed state with "Ready · N triples" when tripleCount is known', async () => {
    const { container, unmount } = await renderWithAttachments([
      draft({
        status: 'completed',
        result: {
          assertionUri: 'urn:dkg:assertion:markdown',
          fileHash: 'sha256:markdown',
          detectedContentType: 'text/markdown',
          extraction: { status: 'completed', tripleCount: 7, pipelineUsed: 'markdown' },
        },
      }),
    ]);
    const chip = container.querySelector('.v10-attachment-chip') as HTMLElement;
    expect(chip.getAttribute('data-status')).toBe('completed');
    expect(chip.querySelector('.v10-attachment-chip-status')?.textContent).toBe('Ready · 7 triples');
    await unmount();
  });

  it('renders completed state with bare "Ready" when tripleCount is missing', async () => {
    const { container, unmount } = await renderWithAttachments([
      draft({
        status: 'completed',
        result: {
          assertionUri: 'urn:dkg:assertion:markdown',
          fileHash: 'sha256:markdown',
          detectedContentType: 'text/markdown',
          extraction: { status: 'completed', pipelineUsed: 'markdown' },
        },
      }),
    ]);
    const chip = container.querySelector('.v10-attachment-chip') as HTMLElement;
    expect(chip.querySelector('.v10-attachment-chip-status')?.textContent).toBe('Ready');
    await unmount();
  });

  it('renders skipped state with "Stored only" label', async () => {
    const { container, unmount } = await renderWithAttachments([draft({ status: 'skipped' })]);
    const chip = container.querySelector('.v10-attachment-chip') as HTMLElement;
    expect(chip.getAttribute('data-status')).toBe('skipped');
    expect(chip.querySelector('.v10-attachment-chip-status')?.textContent).toBe('Stored only');
    await unmount();
  });

  it('renders error state with the draft.error text', async () => {
    const { container, unmount } = await renderWithAttachments([
      draft({ status: 'error', error: 'Upload failed: network reset' }),
    ]);
    const chip = container.querySelector('.v10-attachment-chip') as HTMLElement;
    expect(chip.getAttribute('data-status')).toBe('error');
    expect(chip.querySelector('.v10-attachment-chip-status')?.textContent).toBe(
      'Upload failed: network reset',
    );
    await unmount();
  });

  it('renders error state with "Failed" fallback when no error message is set', async () => {
    const { container, unmount } = await renderWithAttachments([draft({ status: 'error' })]);
    const chip = container.querySelector('.v10-attachment-chip') as HTMLElement;
    expect(chip.getAttribute('data-status')).toBe('error');
    expect(chip.querySelector('.v10-attachment-chip-status')?.textContent).toBe('Failed');
    await unmount();
  });

  it('renders the file-extension badge', async () => {
    const { container, unmount } = await renderWithAttachments([
      draft({ file: new File(['x'], 'image.png', { type: 'image/png' }) }),
    ]);
    const badge = container.querySelector('.v10-attachment-chip-badge');
    expect(badge?.textContent).toBe('IMG');
    await unmount();
  });

  it('renders the formatted file size in the meta row', async () => {
    const { container, unmount } = await renderWithAttachments([
      draft({ file: new File(['x'.repeat(2048)], 'doc.md', { type: 'text/markdown' }) }),
    ]);
    const meta = container.querySelector('.v10-attachment-chip-meta');
    expect(meta?.textContent ?? '').toMatch(/2\.0 KB/);
    await unmount();
  });

  it('renders one chip per draft and preserves their data-status independently', async () => {
    const { container, unmount } = await renderWithAttachments([
      draft({ id: 'a', file: new File(['x'], 'a.md'), status: 'queued' }),
      draft({ id: 'b', file: new File(['x'], 'b.pdf'), status: 'completed' }),
      draft({ id: 'c', file: new File(['x'], 'c.txt'), status: 'error', error: 'bad' }),
    ]);
    const chips = container.querySelectorAll('.v10-attachment-chip');
    expect(chips.length).toBe(3);
    expect(Array.from(chips).map((el) => el.getAttribute('data-status'))).toEqual([
      'queued',
      'completed',
      'error',
    ]);
    await unmount();
  });

  it('clicking the chip remove button calls onRemoveAttachment with the id', async () => {
    const onRemoveAttachment = vi.fn();
    const { container, unmount } = await renderWithAttachments(
      [draft({ id: 'draft-XYZ' })],
      { onRemoveAttachment },
    );
    const removeBtn = container.querySelector('.v10-attachment-chip-remove') as HTMLButtonElement;
    expect(removeBtn).toBeTruthy();
    expect(removeBtn.getAttribute('aria-label')).toBe('Remove spec.md');

    await act(async () => {
      removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRemoveAttachment).toHaveBeenCalledTimes(1);
    expect(onRemoveAttachment).toHaveBeenCalledWith('draft-XYZ');
    await unmount();
  });

  it('disables the remove button while the agent is sending', async () => {
    const onRemoveAttachment = vi.fn();
    const { container, unmount } = await renderWithAttachments(
      [draft()],
      { onRemoveAttachment, localSending: true },
    );
    const removeBtn = container.querySelector('.v10-attachment-chip-remove') as HTMLButtonElement;
    expect(removeBtn.disabled).toBe(true);
    await unmount();
  });

  it('renders the multi-target note only when drafts span more than one project', async () => {
    const single = await renderWithAttachments([
      draft({ id: 'a', contextGraphId: 'testing' }),
      draft({ id: 'b', contextGraphId: 'testing' }),
    ]);
    expect(single.container.textContent).not.toMatch(/multiple projects/i);
    await single.unmount();

    const multi = await renderWithAttachments([
      draft({ id: 'a', contextGraphId: 'testing' }),
      draft({ id: 'b', contextGraphId: 'agents' }),
    ]);
    expect(multi.container.textContent ?? '').toMatch(/multiple projects/i);
    await multi.unmount();
  });
});
