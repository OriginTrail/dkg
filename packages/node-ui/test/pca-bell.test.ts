// @vitest-environment happy-dom
//
// E2 — predictive bell: usePcaAlerts derivation (expiry / fall-through) from the
// polled overview snapshots, and the NotificationsPane PCA section (additive,
// danger = role=alert). Uses the shared E3 fixtures.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWalletsBalances: vi.fn(),
  fetchPca: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, fetchWalletsBalances: mocks.fetchWalletsBalances, fetchPca: mocks.fetchPca };
});

const { usePcaAlerts } = await import('../src/ui/hooks/usePcaAlerts.js');
const { NotificationsPane } = await import('../src/ui/components/Notifications/NotificationsPane.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { makePcaSnapshot, MOCK_OWNER } = await import('../src/ui/mocks/pca.js');

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function waitFor(fn: () => boolean) {
  const started = Date.now();
  while (Date.now() - started < 1500) {
    if (fn()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error('Timed out');
}

function AlertsHarness() {
  const alerts = usePcaAlerts();
  return React.createElement(
    'div',
    { 'data-testid': 'alerts' },
    alerts.map((a) => React.createElement('span', { key: a.id, 'data-kind': a.kind, 'data-sev': a.severity }, `${a.title} — ${a.message}`)),
  );
}

const stubFeed = () => ({
  joinRequests: [], activity: [], status: 'ok' as const, refreshError: null, partialActivityError: false,
  hasInformationalUnread: false, unread: 0,
  approve: vi.fn(), deny: vi.fn(), markSeen: vi.fn(), markAllInformationalSeen: vi.fn(), retry: vi.fn(),
}) as any;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [MOCK_OWNER], balances: [{ address: MOCK_OWNER, eth: '1', trac: '5', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('usePcaAlerts derivation', () => {
  it('emits a DANGER expired alert for an expired owned account', async () => {
    usePcaStore.setState({ trackedIds: ['9'], createPending: null });
    const expired = makePcaSnapshot({ accountId: '9', owner: MOCK_OWNER, expiresAtTimestamp: Math.floor(Date.now() / 1000) - 86_400 });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...expired, probedKey: { key, registered: true } } : expired,
    );
    const { container, unmount } = await render(React.createElement(AlertsHarness));
    await waitFor(() => !!container.querySelector('[data-kind="expired"]'));
    expect(container.querySelector('[data-kind="expired"]')?.getAttribute('data-sev')).toBe('danger');
    await unmount();
  });

  it('emits a fall-through alert for an owned PCA covering 0 of its wallets', async () => {
    usePcaStore.setState({ trackedIds: ['7'], createPending: null });
    const healthy = makePcaSnapshot({ accountId: '7', owner: MOCK_OWNER });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...healthy, probedKey: { key, registered: false } } : healthy,
    );
    const { container, unmount } = await render(React.createElement(AlertsHarness));
    await waitFor(() => !!container.querySelector('[data-kind="fallthrough"]'));
    expect(container.textContent).toContain('Pending confirmation');
    await unmount();
  });

  // M6/F8 — co-occurring concerns each surface independently (not collapsed to
  // the single HealthChip precedence): cap-near must NOT hide expiring-soon.
  it('emits BOTH cap-near and expiring alerts for an account that is both (M6)', async () => {
    usePcaStore.setState({ trackedIds: ['11'], createPending: null });
    const both = makePcaSnapshot({
      accountId: '11',
      owner: MOCK_OWNER,
      agentCount: 96, // ≥ PCA_CAP_NEAR_THRESHOLD
      expiresAtTimestamp: Math.floor(Date.now() / 1000) + 3 * 86_400, // within the 7-day window
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...both, probedKey: { key, registered: true } } : both,
    );
    const { container, unmount } = await render(React.createElement(AlertsHarness));
    await waitFor(() => !!container.querySelector('[data-kind="cap-near"]') && !!container.querySelector('[data-kind="expiring"]'));
    expect(container.querySelector('[data-kind="cap-near"]')).toBeTruthy();
    expect(container.querySelector('[data-kind="expiring"]')).toBeTruthy();
    await unmount();
  });
});

describe('NotificationsPane PCA section', () => {
  it('renders the PCA alerts section (danger row = role=alert) and wires onOpenPca', async () => {
    const onOpenPca = vi.fn();
    const { container, unmount } = await render(
      React.createElement(NotificationsPane, {
        feed: stubFeed(),
        onOpenContextGraph: vi.fn(),
        onOpenPca,
        pcaAlerts: [
          { id: 'pca-9-expired', accountId: '9', kind: 'expired', severity: 'danger', title: 'PCA #9 has expired', message: 'x' },
        ],
      }),
    );
    const row = container.querySelector('[data-testid="pca-bell-alert"]')!;
    expect(row).toBeTruthy();
    expect(row.getAttribute('role')).toBe('alert');
    expect(container.textContent).toContain('Publisher Conviction');
    const manage = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Manage PCA #9'))!;
    manage.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOpenPca).toHaveBeenCalledWith('9');
    await unmount();
  });

  it('renders no PCA section when there are no alerts (additive default)', async () => {
    const { container, unmount } = await render(
      React.createElement(NotificationsPane, { feed: stubFeed(), onOpenContextGraph: vi.fn() }),
    );
    expect(container.querySelector('.v10-notif-section-pca')).toBeNull();
    // The unchanged empty state still renders.
    expect(container.textContent).toContain('all caught up');
    await unmount();
  });
});
