// @vitest-environment happy-dom
//
// N4 — PcaDashboardRow (the Dashboard "Publisher discount" row, the primary
// discovery surface) was the lone untested PCA component. Pins: covered shows the
// discount + "pending confirmation" (#9, data-covered=true); uncovered shows
// "None — publishing at the direct cost"; the CTA label is role-dependent and
// opens the conviction tab. Deps are mocked (the row is pure presentation).

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  overview: { covered: false, bestCoveringDiscountBps: null as number | null, walletsInconclusive: false },
  nodeRole: undefined as string | undefined,
  openTab: vi.fn(),
}));

vi.mock('../src/ui/hooks/usePcaOverview.js', () => ({ usePcaOverview: () => state.overview }));
vi.mock('../src/ui/stores/agents.js', () => ({
  useAgentsStore: (sel: (s: unknown) => unknown) => sel({ nodeStatus: { nodeRole: state.nodeRole } }),
}));
vi.mock('../src/ui/stores/tabs.js', () => ({
  useTabsStore: (sel: (s: unknown) => unknown) => sel({ openTab: state.openTab }),
}));

const { PcaDashboardRow } = await import('../src/ui/pages/conviction/PcaDashboardRow.js');

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
  state.overview = { covered: false, bestCoveringDiscountBps: null, walletsInconclusive: false };
  state.nodeRole = undefined;
  state.openTab = vi.fn();
});
afterEach(() => { document.body.innerHTML = ''; });

describe('PcaDashboardRow', () => {
  it('covered → discount + "pending confirmation", data-covered=true', async () => {
    state.overview = { covered: true, bestCoveringDiscountBps: 1000, walletsInconclusive: false };
    const { container, unmount } = await render(React.createElement(PcaDashboardRow));
    const value = container.querySelector('.v10-ws-pca-value')!;
    expect(value.getAttribute('data-covered')).toBe('true');
    expect(value.textContent).toContain('10%');
    expect(value.textContent).toContain('pending confirmation');
    await unmount();
  });

  it('uncovered → "None — publishing at the direct cost", data-covered=false', async () => {
    state.overview = { covered: false, bestCoveringDiscountBps: null, walletsInconclusive: false };
    const { container, unmount } = await render(React.createElement(PcaDashboardRow));
    const value = container.querySelector('.v10-ws-pca-value')!;
    expect(value.getAttribute('data-covered')).toBe('false');
    expect(value.textContent).toBe('None — publishing at the direct cost');
    await unmount();
  });

  // T2/#9 — unreadable wallets must not read as "None".
  it('walletsInconclusive → "Couldn’t verify your wallets", not "None"', async () => {
    state.overview = { covered: false, bestCoveringDiscountBps: null, walletsInconclusive: true };
    const { container, unmount } = await render(React.createElement(PcaDashboardRow));
    const value = container.querySelector('.v10-ws-pca-value')!;
    expect(value.textContent).toContain('Couldn’t verify your wallets');
    expect(value.textContent).not.toContain('None — publishing');
    await unmount();
  });

  it('CTA label is role-dependent (edge -> Get added; core -> Set up)', async () => {
    state.nodeRole = 'edge';
    const edge = await render(React.createElement(PcaDashboardRow));
    expect(edge.container.querySelector('.v10-ws-pca-cta')!.textContent).toMatch(/Get added to a PCA/);
    await edge.unmount();

    state.nodeRole = 'core';
    const core = await render(React.createElement(PcaDashboardRow));
    expect(core.container.querySelector('.v10-ws-pca-cta')!.textContent).toMatch(/Set up PCA/);
    await core.unmount();
  });

  it('CTA click opens the conviction tab', async () => {
    const { container, unmount } = await render(React.createElement(PcaDashboardRow));
    await act(async () => {
      container.querySelector('.v10-ws-pca-cta')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(state.openTab).toHaveBeenCalledTimes(1);
    expect(state.openTab).toHaveBeenCalledWith({ id: 'conviction', label: 'Publisher Conviction', closable: true });
    await unmount();
  });
});
