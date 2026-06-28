// @vitest-environment happy-dom
//
// B1/B2 — the conviction tab root (503 deployment gate) + S1 overview discovery.
// Mocks only the two PCA fetchers on api.js (keeping HttpError +
// isPcaFeatureUnavailable real) and drives the tracked-id store directly.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchPca: vi.fn(),
  fetchWalletsBalances: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, fetchPca: mocks.fetchPca, fetchWalletsBalances: mocks.fetchWalletsBalances };
});

const { HttpError } = await import('../src/ui/api.js');
const { PublishingConvictionPage } = await import('../src/ui/pages/PublishingConviction.js');
const { ConvictionOverview } = await import('../src/ui/pages/conviction/ConvictionOverview.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { useAgentsStore } = await import('../src/ui/stores/agents.js');

const WALLET0 = '0x9A3f000000000000000000000000000000000E41D';

function snapFixture(id: string) {
  return {
    accountId: id,
    owner: WALLET0,
    committedTRAC: '100000000000000000000000',
    committedTRACTrac: '100000.0',
    baseEpochAllowance: '850000000000000000000',
    topUpBuffer: '12500000000000000000000',
    topUpBufferTrac: '12500.0',
    createdAtEpoch: 1200,
    expiresAtEpoch: 1560,
    createdAtTimestamp: 1000,
    expiresAtTimestamp: 9_999_999_999,
    discountBps: 3000,
    agentCount: 4,
    lastSettledWindow: 0,
    fullySwept: false,
  };
}

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function waitForText(container: HTMLElement, text: string): Promise<void> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 1500) {
    last = container.textContent ?? '';
    if (last.includes(text)) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`Timed out waiting for "${text}" in "${last}"`);
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
  usePcaStore.setState({ trackedIds: [], createPending: null });
  useAgentsStore.getState().setNodeStatus({ nodeRole: 'core', blockExplorerUrl: null });
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('PublishingConvictionPage — deployment (503) gate', () => {
  it('shows the full-tab Deployment-Unavailable state on a 503', async () => {
    mocks.fetchPca.mockRejectedValue(new HttpError(503));
    const { container, unmount } = await render(React.createElement(PublishingConvictionPage));
    await waitForText(container, "isn’t available on this network");
    // e2e anchors: the full-tab unavailable state + its Recheck control.
    expect(container.querySelector('[data-testid="pca-view"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-unavailable"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-recheck-btn"]')).toBeTruthy();
    // The overview title must NOT render under the gate.
    expect(container.textContent).not.toContain('Role: ◆');
    await unmount();
  });

  it('renders the overview when the capability probe succeeds (non-503)', async () => {
    mocks.fetchPca.mockResolvedValue(snapFixture('0'));
    const { container, unmount } = await render(React.createElement(PublishingConvictionPage));
    await waitForText(container, 'Publishing Conviction');
    expect(container.querySelector('[data-testid="pca-view"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-landing"]')).toBeTruthy();
    await unmount();
  });

  // Q4 — Recheck re-probes (the availability nonce increments) and clears the 503
  // gate once the capability probe recovers.
  it('Recheck re-probes and clears the 503 gate on recovery', async () => {
    mocks.fetchPca.mockRejectedValueOnce(new HttpError(503)).mockResolvedValue(snapFixture('0'));
    const { container, unmount } = await render(React.createElement(PublishingConvictionPage));
    await waitForText(container, "isn’t available on this network");
    expect(container.querySelector('[data-testid="pca-unavailable"]')).toBeTruthy();

    await act(async () => {
      container.querySelector('[data-testid="pca-recheck-btn"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForText(container, 'Publishing Conviction');
    expect(container.querySelector('[data-testid="pca-unavailable"]')).toBeNull();
    expect(container.querySelector('[data-testid="pca-landing"]')).toBeTruthy();
    await unmount();
  });
});

describe('ConvictionOverview — S1 discovery', () => {
  it('core empty state teaches the feature with the discount-tier ladder', async () => {
    // No tracked ids → usePcaOverview resolves to [] without any fetch.
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'What is a Publishing Conviction Account');
    // The tier ladder is present (estimated caption).
    expect(container.textContent?.toLowerCase()).toContain('estimated');
    await unmount();
  });

  it('edge empty state shows the warning-tone no-discount banner', async () => {
    useAgentsStore.getState().setNodeStatus({ nodeRole: 'edge', blockExplorerUrl: null });
    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'No PCA discount on this node');
    await unmount();
  });

  it('classifies a tracked account the node owns under "Owned by me"', async () => {
    usePcaStore.setState({ trackedIds: ['7'], createPending: null });
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [WALLET0],
      balances: [],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = snapFixture(id);
      if (key) return { ...base, probedKey: { key, registered: key.toLowerCase() === WALLET0.toLowerCase() } };
      return base;
    });

    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    await waitForText(container, 'PCA #7');
    const card = container.querySelector('[data-state="owned"]');
    expect(card).toBeTruthy();
    // owner == wallets[0] AND that wallet probes registered → covered → no #11 warning.
    expect(container.textContent).not.toContain('discounts nothing yet');
    await unmount();
  });

  // O2 — the role-default filter must auto-react to async status (a useState
  // initializer runs once, so an edge node whose status resolved after mount
  // stayed stuck on "Owned" and hid its sponsorships); explicit picks stick.
  it('O2 — edge default syncs to "Approved for me" after async role resolves; explicit pick preserved', async () => {
    usePcaStore.setState({ trackedIds: ['7'], createPending: null });
    useAgentsStore.setState({ nodeStatus: null }); // status not loaded yet → role undefined
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [WALLET0], balances: [], chainId: '84532', rpcUrl: null });
    const SPONSOR = '0xSOMEONEELSE0000000000000000000000000000';
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = { ...snapFixture(id), owner: SPONSOR }; // not owned by this node → 'approved'
      if (key) return { ...base, probedKey: { key, registered: key.toLowerCase() === WALLET0.toLowerCase() } };
      return base;
    });

    const { container, unmount } = await render(React.createElement(ConvictionOverview));
    const tab = (label: string) =>
      Array.from(container.querySelectorAll('[role="tab"]')).find((b) => b.textContent?.trim() === label)!;

    // Status resolves to edge AFTER mount → default flips to "Approved for me".
    await act(async () => {
      useAgentsStore.setState({ nodeStatus: { nodeRole: 'edge', blockExplorerUrl: null } });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitForText(container, 'PCA #7'); // the approved sponsorship is visible by default — NO click
    expect(tab('Approved for me').getAttribute('aria-selected')).toBe('true');
    expect(tab('Owned by me').getAttribute('aria-selected')).toBe('false');

    // An explicit pick survives a later role update.
    await act(async () => { tab('Owned by me').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(tab('Owned by me').getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      useAgentsStore.setState({ nodeStatus: { nodeRole: 'edge', blockExplorerUrl: null } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(tab('Owned by me').getAttribute('aria-selected')).toBe('true'); // role default did NOT override
    await unmount();
  });
});
