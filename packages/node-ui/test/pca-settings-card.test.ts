// @vitest-environment happy-dom
//
// O5 — PcaSettingsCard (Settings -> Publisher Conviction). Pins: no-tracked / covered
// exact discount-tier / tracked-but-uncovered copy, and the Manage CTA opens the
// conviction tab. Deps mocked (the card is pure presentation off usePcaOverview).

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  overview: {
    accounts: [] as unknown[],
    covered: false,
    bestCoveringDiscountBps: null as number | null,
    walletsInconclusive: false,
  },
  openTab: vi.fn(),
  bootstrapScope: vi.fn(),
}));

// The components read the coverage state; derive it from the test's flags unless a test sets it.
vi.mock('../src/ui/hooks/usePcaOverview.js', () => ({
  usePcaOverview: () => ({
    ...state.overview,
    coverage: (state.overview as { coverage?: unknown }).coverage ?? {
      status: state.overview.covered ? 'covered' : state.overview.walletsInconclusive ? 'uncertain' : 'not-covered',
      uncertainty: state.overview.walletsInconclusive ? 'wallets-unreadable' : null,
    },
  }),
}));
vi.mock('../src/ui/hooks/usePcaScopeBootstrap.js', () => ({ usePcaScopeBootstrap: () => state.bootstrapScope() }));
vi.mock('../src/ui/stores/tabs.js', () => ({
  useTabsStore: Object.assign((sel: (s: unknown) => unknown) => sel({ openTab: state.openTab }), {
    getState: () => ({ activeTabId: 'dashboard', openTab: (...a: unknown[]) => state.openTab(...a) }),
  }),
}));

const { PcaSettingsCard } = await import('../src/ui/pages/conviction/PcaSettingsCard.js');

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
  state.overview = { accounts: [], covered: false, bestCoveringDiscountBps: null, walletsInconclusive: false };
  state.openTab = vi.fn();
  state.bootstrapScope = vi.fn();
});
afterEach(() => { document.body.innerHTML = ''; });

describe('PcaSettingsCard', () => {
  it('no tracked account → the no-tracked line', async () => {
    const { container, unmount } = await render(React.createElement(PcaSettingsCard));
    expect(state.bootstrapScope).toHaveBeenCalled();
    expect(container.textContent).toContain('This node has no Publisher Conviction Accounts (PCAs) yet.');
    expect(container.textContent).not.toContain('Manage PCA'); // nothing to manage yet
    await unmount();
  });

  it('covered → exact discount tier', async () => {
    state.overview = { accounts: [{}], covered: true, bestCoveringDiscountBps: 1000, walletsInconclusive: false };
    const { container, unmount } = await render(React.createElement(PcaSettingsCard));
    expect(container.textContent).toContain('10%');
    expect(container.textContent).toContain('This node’s approved publishing wallets get a');
    expect(container.textContent).toContain('Publisher Conviction Account (PCA)');
    expect(container.textContent).not.toContain('pending confirmation');
    await unmount();
  });

  // T2/#9 — unreadable wallets must not read as "none currently covers".
  it('tracked + walletsInconclusive → "couldn’t check" with a Retry button, not "none covers"', async () => {
    state.overview = { accounts: [{}], covered: false, bestCoveringDiscountBps: null, walletsInconclusive: true };
    const { container, unmount } = await render(React.createElement(PcaSettingsCard));
    expect(container.textContent).toContain('Couldn’t check this node’s wallets');
    expect(container.textContent).not.toContain('covers this node');
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Retry', 'Manage PCA']);
    await unmount();
  });

  // #9 — the wallets read fine, but a tracked PCA or a wallet's approval on it couldn't be checked.
  it('a failed approval check → "couldn’t check" with Retry, not "none covers"', async () => {
    state.overview = { accounts: [{}], covered: false, bestCoveringDiscountBps: null, walletsInconclusive: false, coverage: { status: 'uncertain', uncertainty: 'probe-inconclusive', recovery: 'retry-read' } } as typeof state.overview;
    const { container, unmount } = await render(React.createElement(PcaSettingsCard));
    expect(container.textContent).toContain('Couldn’t check this node’s wallets');
    expect(container.textContent).not.toContain('covers this node');
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Retry', 'Manage PCA']);
    await unmount();
  });

  it('tracked but uncovered → the count + "covers" line', async () => {
    state.overview = { accounts: [{}, {}], covered: false, bestCoveringDiscountBps: null, walletsInconclusive: false };
    const { container, unmount } = await render(React.createElement(PcaSettingsCard));
    expect(container.textContent).toContain('None of the Publisher Conviction Accounts (PCAs) you’ve added (2) covers this node’s publishes.');
    await unmount();
  });

  it('Manage CTA opens the conviction tab', async () => {
    state.overview = { accounts: [{}], covered: true, bestCoveringDiscountBps: 1000, walletsInconclusive: false };
    const { container, unmount } = await render(React.createElement(PcaSettingsCard));
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((b) => /Manage PCA/.test(b.textContent ?? ''))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(state.openTab).toHaveBeenCalledWith({ id: 'conviction', label: 'Publisher Conviction', closable: true });
    await unmount();
  });
});
