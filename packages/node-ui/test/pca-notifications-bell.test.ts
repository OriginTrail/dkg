// @vitest-environment happy-dom
//
// O6 — NotificationsBell folds the client-derived predictive PCA alerts into the
// unread badge and routes "Manage PCA #N" to the conviction tab. Bell-level test:
// the feed + alerts + stores are mocked so only the bell wiring is exercised.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  alerts: [] as Array<{ id: string; accountId: string; kind: string; severity: string; title: string; message: string }>,
  feed: {
    joinRequests: [] as unknown[],
    activity: [] as unknown[],
    status: 'ok' as const,
    refreshError: null as unknown,
    partialActivityError: false,
    hasInformationalUnread: false,
    unread: 0,
    approve: vi.fn(),
    deny: vi.fn(),
    markSeen: vi.fn(),
    markAllInformationalSeen: vi.fn(),
    retry: vi.fn(),
  },
  openTab: vi.fn(),
  setActiveProject: vi.fn(),
}));

vi.mock('../src/ui/hooks/usePcaAlerts.js', () => ({ usePcaAlerts: () => state.alerts }));
vi.mock('../src/ui/hooks/useNotificationsFeed.js', () => ({ useNotificationsFeed: () => state.feed }));
vi.mock('../src/ui/stores/tabs.js', () => ({ useTabsStore: () => ({ openTab: state.openTab }) }));
vi.mock('../src/ui/stores/projects.js', () => ({
  useProjectsStore: (sel: (s: unknown) => unknown) => sel({ setActiveProject: state.setActiveProject }),
}));

const { NotificationsBell } = await import('../src/ui/components/Shell/NotificationsBell.js');

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  state.alerts = [];
  state.feed.unread = 0;
  state.openTab = vi.fn();
  state.setActiveProject = vi.fn();
});
afterEach(() => { document.body.innerHTML = ''; });

const PCA_ALERT = {
  id: 'pca-7-expired',
  accountId: '7',
  kind: 'expired',
  severity: 'danger',
  title: 'PCA #7 has expired',
  message: 'Publishes no longer get its discount.',
};

describe('NotificationsBell — PCA alerts', () => {
  it('folds the PCA alert count into the unread badge (feed unread 0 + 1 alert → 1)', async () => {
    state.alerts = [PCA_ALERT];
    const { container, unmount } = await render(React.createElement(NotificationsBell));
    expect(container.querySelector('.v10-header-notif-badge')?.textContent).toBe('1');
    expect(container.querySelector('.v10-header-icon-btn')?.getAttribute('aria-label')).toBe('Notifications, 1 unread');
    await unmount();
  });

  it('opening the bell and clicking "Manage PCA #7" opens conviction:7', async () => {
    state.alerts = [PCA_ALERT];
    const { container, unmount } = await render(React.createElement(NotificationsBell));
    await act(async () => {
      container.querySelector('.v10-header-icon-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const manage = Array.from(container.querySelectorAll('button')).find((b) => /Manage PCA #7/.test(b.textContent ?? ''))!;
    expect(manage).toBeTruthy();
    await act(async () => { manage.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(state.openTab).toHaveBeenCalledWith({ id: 'conviction:7', label: 'PCA #7', closable: true });
    await unmount();
  });

  it('no badge when there are no alerts and an empty feed', async () => {
    const { container, unmount } = await render(React.createElement(NotificationsBell));
    expect(container.querySelector('.v10-header-notif-badge')).toBeNull();
    await unmount();
  });
});
