// @vitest-environment happy-dom
//
// O5 — PcaSettingsCard (Settings → Publishing Conviction). Pins: no-tracked / covered
// ("pending confirmation") / tracked-but-uncovered copy, and the Manage CTA opens the
// conviction tab. Deps mocked (the card is pure presentation off usePcaOverview).

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  overview: { accounts: [] as unknown[], covered: false, bestCoveringDiscountBps: null as number | null },
  openTab: vi.fn(),
}));

vi.mock('../src/ui/hooks/usePcaOverview.js', () => ({ usePcaOverview: () => state.overview }));
vi.mock('../src/ui/stores/tabs.js', () => ({
  useTabsStore: (sel: (s: unknown) => unknown) => sel({ openTab: state.openTab }),
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
  state.overview = { accounts: [], covered: false, bestCoveringDiscountBps: null };
  state.openTab = vi.fn();
});
afterEach(() => { document.body.innerHTML = ''; });

describe('PcaSettingsCard', () => {
  it('no tracked account → the no-tracked line', async () => {
    const { container, unmount } = await render(React.createElement(PcaSettingsCard));
    expect(container.textContent).toContain('No tracked Publishing Conviction Account');
    await unmount();
  });

  it('covered → discount + "pending confirmation"', async () => {
    state.overview = { accounts: [{}], covered: true, bestCoveringDiscountBps: 1000 };
    const { container, unmount } = await render(React.createElement(PcaSettingsCard));
    expect(container.textContent).toContain('10%');
    expect(container.textContent).toContain('pending confirmation');
    await unmount();
  });

  it('tracked but uncovered → the count + "none currently covers" line', async () => {
    state.overview = { accounts: [{}, {}], covered: false, bestCoveringDiscountBps: null };
    const { container, unmount } = await render(React.createElement(PcaSettingsCard));
    expect(container.textContent).toContain('Tracking 2 accounts');
    expect(container.textContent).toContain('none currently covers');
    await unmount();
  });

  it('Manage CTA opens the conviction tab', async () => {
    const { container, unmount } = await render(React.createElement(PcaSettingsCard));
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((b) => /Manage publishing conviction/i.test(b.textContent ?? ''))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(state.openTab).toHaveBeenCalledWith({ id: 'conviction', label: 'Publishing Conviction', closable: true });
    await unmount();
  });
});
