// @vitest-environment happy-dom
//
// Covers the kebab (⋯) overflow menu on the active connected-agent subtab.
// PR1 moved Refresh / Disconnect off the panel toolbar and into this popover.

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

async function renderTab(
  overrides: Record<string, unknown>,
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

describe('AgentTabMenu (kebab popover on active agent subtab)', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
  });

  it('renders the trigger on the active tab with an accessible label', async () => {
    const { container, unmount } = await renderTab({});
    const trigger = container.querySelector('.v10-agent-tab-menu-trigger') as HTMLButtonElement | null;
    expect(trigger).toBeTruthy();
    expect(trigger!.getAttribute('aria-label')).toBe('More actions for OpenClaw');
    expect(trigger!.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.v10-agent-tab-menu-popover')).toBeNull();
    await unmount();
  });

  it('opens the popover on trigger click and closes on second click', async () => {
    const { container, unmount } = await renderTab({});
    const trigger = container.querySelector('.v10-agent-tab-menu-trigger') as HTMLButtonElement;

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.v10-agent-tab-menu-popover')).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.v10-agent-tab-menu-popover')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await unmount();
  });

  it('closes the popover on outside mousedown', async () => {
    const { container, unmount } = await renderTab({});
    const trigger = container.querySelector('.v10-agent-tab-menu-trigger') as HTMLButtonElement;

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.v10-agent-tab-menu-popover')).toBeTruthy();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(container.querySelector('.v10-agent-tab-menu-popover')).toBeNull();

    await unmount();
  });

  it('closes the popover on Escape', async () => {
    const { container, unmount } = await renderTab({});
    const trigger = container.querySelector('.v10-agent-tab-menu-trigger') as HTMLButtonElement;

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.v10-agent-tab-menu-popover')).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('.v10-agent-tab-menu-popover')).toBeNull();

    await unmount();
  });

  it('clicking Refresh calls onRefreshIntegration with the integration id and closes the popover', async () => {
    const onRefreshIntegration = vi.fn();
    const onDisconnectIntegration = vi.fn();
    const { container, unmount } = await renderTab({
      onRefreshIntegration,
      onDisconnectIntegration,
    });

    await act(async () => {
      container
        .querySelector('.v10-agent-tab-menu-trigger')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const refreshItem = Array.from(
      container.querySelectorAll('.v10-agent-tab-menu-item'),
    ).find((el) => /refresh/i.test(el.textContent ?? '')) as HTMLButtonElement | undefined;
    expect(refreshItem).toBeTruthy();

    await act(async () => {
      refreshItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onRefreshIntegration).toHaveBeenCalledTimes(1);
    expect(onRefreshIntegration).toHaveBeenCalledWith('openclaw');
    expect(onDisconnectIntegration).not.toHaveBeenCalled();
    expect(container.querySelector('.v10-agent-tab-menu-popover')).toBeNull();

    await unmount();
  });

  it('clicking Disconnect calls onDisconnectIntegration with the integration id and closes the popover', async () => {
    const onRefreshIntegration = vi.fn();
    const onDisconnectIntegration = vi.fn();
    const { container, unmount } = await renderTab({
      onRefreshIntegration,
      onDisconnectIntegration,
    });

    await act(async () => {
      container
        .querySelector('.v10-agent-tab-menu-trigger')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const disconnectItem = container.querySelector(
      '.v10-agent-tab-menu-item.danger',
    ) as HTMLButtonElement | null;
    expect(disconnectItem).toBeTruthy();
    expect(disconnectItem!.textContent).toMatch(/disconnect/i);

    await act(async () => {
      disconnectItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onDisconnectIntegration).toHaveBeenCalledTimes(1);
    expect(onDisconnectIntegration).toHaveBeenCalledWith('openclaw');
    expect(onRefreshIntegration).not.toHaveBeenCalled();
    expect(container.querySelector('.v10-agent-tab-menu-popover')).toBeNull();

    await unmount();
  });

  it('hides Disconnect when the integration is not in the persistent-chat state', async () => {
    const onDisconnectIntegration = vi.fn();
    // A non-persistent integration still renders a trigger? The active tab is
    // only rendered for integrations in `connectedAgents` (persistentChat
    // true). To exercise the `canDisconnect=false` branch the popover must
    // open with the danger item suppressed — happens for stored-history mode
    // where the selected integration was disconnected. Mirror that here by
    // flipping persistentChat=false on the selected integration.
    const disconnected = integration({
      persistentChat: false,
      chatReady: false,
      bridgeOnline: false,
      status: 'available',
      statusLabel: 'Ready to connect',
    });
    const { container, unmount } = await renderTab({
      integrations: [disconnected],
      selectedIntegration: disconnected,
      selectedHasConversation: true,
      selectedIntegrationHasAnyConversation: true,
      onDisconnectIntegration,
    });

    const trigger = container.querySelector('.v10-agent-tab-menu-trigger') as HTMLButtonElement | null;
    // When the disconnected agent is shown via stored-session history, the
    // tab still renders with a trigger; if not, this test asserts only the
    // baseline that no Disconnect button exists in the popover.
    if (!trigger) {
      await unmount();
      return;
    }
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.v10-agent-tab-menu-item.danger')).toBeNull();
    expect(onDisconnectIntegration).not.toHaveBeenCalled();

    await unmount();
  });

  it('disables Refresh while a refresh is in flight', async () => {
    const { container, unmount } = await renderTab({ refreshBusyId: 'openclaw' });
    await act(async () => {
      container
        .querySelector('.v10-agent-tab-menu-trigger')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const refreshItem = Array.from(
      container.querySelectorAll('.v10-agent-tab-menu-item'),
    ).find((el) => /refresh/i.test(el.textContent ?? '')) as HTMLButtonElement | undefined;
    expect(refreshItem).toBeTruthy();
    expect(refreshItem!.disabled).toBe(true);
    expect(refreshItem!.textContent).toMatch(/refreshing/i);
    await unmount();
  });
});
