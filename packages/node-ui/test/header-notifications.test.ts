// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

// ─────────────────────────────────────────────────────────────────────
// Header mounts <NotificationsBell/> — the bell + dropdown were EXTRACTED
// out of Header in the notifications-pane redesign. NotificationsBell drives
// useNotificationsFeed → api.fetchNotificationsFeed (the scoped feed) +
// useNodeEvents (EventSource) + useVisibilityPolling. We mock the scoped feed
// so the bell renders deterministically and stub EventSource (happy-dom lacks
// one).
//
// The dropdown's INTERNAL behaviour (sort, empty-state copy, inline
// approve/deny, the read model — incl. that opening the bell no longer
// auto-marks-read) now lives in NotificationsBell/NotificationsPane and is
// covered by `notifications-pane.dom.test.ts`. This file keeps only the
// Header-LEVEL wiring: the bell badge/aria-label and the status-pill tooltip
// (BUG-020).
// ─────────────────────────────────────────────────────────────────────

const fetchNotificationsFeedMock = vi.fn();
const markNotificationsReadMock = vi.fn();
const fetchCurrentAgentMock = vi.fn();
const fetchStatusMock = vi.fn();

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    fetchNotificationsFeed: fetchNotificationsFeedMock,
    markNotificationsRead: markNotificationsReadMock,
    fetchCurrentAgent: fetchCurrentAgentMock,
  };
});

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: {
    fetchNotificationsFeed: fetchNotificationsFeedMock,
    markNotificationsRead: markNotificationsReadMock,
    fetchCurrentAgent: fetchCurrentAgentMock,
    fetchStatus: fetchStatusMock,
  },
}));

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function flush(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderHeader() {
  const { Header } = await import('../src/ui/components/Shell/Header.js');
  const { useAgentsStore } = await import('../src/ui/stores/agents.js');
  act(() => {
    useAgentsStore.setState({
      nodeStatus: {
        synced: true,
        connectedPeers: 3,
        connections: { direct: 2, relayed: 1 },
        uptimeMs: 60_000,
        name: 'TestNode',
      } as any,
    });
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Header));
  });
  await flush();
  mountedRoots.push(root);
  mountedContainers.push(container);
  return container;
}

function findBellButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector('button[aria-label^="Notifications"]') as HTMLButtonElement | null;
  if (!btn) throw new Error('bell button not found');
  return btn;
}

describe('Header — notifications bell + status wiring', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    // EventSource stub for useNodeEvents — happy-dom doesn't provide one.
    (globalThis as any).EventSource = class StubEventSource {
      url: string;
      readyState = 0;
      onopen: ((e: any) => void) | null = null;
      onmessage: ((e: any) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      constructor(url: string) { this.url = url; }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    };
    fetchCurrentAgentMock.mockResolvedValue({
      agentAddress: '0xabcd00000000000000000000000000000000abcd',
      agentDid: 'did:dkg:agent:0xabcd',
      name: 'Local Agent',
      peerId: 'peer-x',
    });
    fetchStatusMock.mockResolvedValue({
      synced: true,
      connectedPeers: 3,
      connections: { direct: 2, relayed: 1 },
      uptimeMs: 60_000,
    });
    markNotificationsReadMock.mockResolvedValue({ marked: 0 });
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }
    vi.useRealTimers();
  });

  it('Header mounts the notifications bell with a Notifications aria-label/tooltip (BUG-002 a11y wiring)', async () => {
    fetchNotificationsFeedMock.mockResolvedValue({ notifications: [], badgeCount: 0 });
    const container = await renderHeader();
    const bell = findBellButton(container);
    expect(bell.getAttribute('aria-label')).toBe('Notifications');
    expect(bell.getAttribute('title')).toBe('Notifications');
  });

  it('bell badge/aria-label reflect the scoped unread count (badgeCount) when > 0', async () => {
    // unread is driven by the daemon's scoped badgeCount (rejections excluded).
    fetchNotificationsFeedMock.mockResolvedValue({ notifications: [], badgeCount: 2 });
    const container = await renderHeader();
    const bell = findBellButton(container);
    expect(bell.getAttribute('aria-label')).toBe('Notifications, 2 unread');
    expect(bell.getAttribute('title')).toBe('Notifications (2 unread)');
    expect(container.querySelector('.v10-header-notif-badge')?.textContent).toBe('2');
  });

  it('status pill exposes the multiline tooltip with synced + peer breakdown (BUG-020 wiring)', async () => {
    fetchNotificationsFeedMock.mockResolvedValue({ notifications: [], badgeCount: 0 });
    const container = await renderHeader();
    const meta = container.querySelector('.v10-header-meta') as HTMLElement | null;
    expect(meta).toBeTruthy();
    const tooltip = meta!.getAttribute('title') ?? '';
    expect(tooltip).toContain('Synced with the network');
    expect(tooltip).toContain('3 peers (2 direct, 1 relayed)');
    expect(tooltip).toContain('Uptime');
  });
});
