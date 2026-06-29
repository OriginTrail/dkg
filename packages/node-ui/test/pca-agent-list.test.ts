// @vitest-environment happy-dom
//
// B3 — PcaAgentList unit contract: the FULL approved-wallet list (chain enumerator)
// renders one row per address, badges this node's wallets, and exposes an
// owner-gated, consequence-naming Remove reusing the detail view's deregister flow.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PcaAgentList } from '../src/ui/components/Pca/index.js';

const NODE = '0x9A3f000000000000000000000000000000000E41D';
const EXTERNAL = '0xExternal0000000000000000000000000000A1b2';

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}
const findBtn = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent === text);

const baseProps = {
  agents: [NODE, EXTERNAL],
  nodeWallets: [NODE],
  ownerIsPrimary: true,
  confirmRemove: null as string | null,
  onAskRemove: vi.fn(),
  onCancelRemove: vi.fn(),
  onConfirmRemove: vi.fn(),
  removeBusy: false,
};

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});
afterEach(() => { document.body.innerHTML = ''; });

describe('PcaAgentList (B3)', () => {
  it('renders one row per approved wallet and badges this node’s wallet', async () => {
    const { container, unmount } = await render(React.createElement(PcaAgentList, { ...baseProps }));
    expect(container.querySelectorAll('[data-testid="pca-agent-row"]').length).toBe(2);
    // The node-owned wallet is badged; the external approved wallet is plain "approved".
    expect(container.textContent).toContain('approved · this node');
    // The external row carries the full address in its accessible name (never glyph-only).
    const groups = Array.from(container.querySelectorAll('[role="group"]')).map((g) => g.getAttribute('aria-label'));
    expect(groups.some((l) => l?.includes(EXTERNAL))).toBe(true);
    await unmount();
  });

  it('owner-gates Remove: disabled (with a reason title) when not owner-primary', async () => {
    const { container, unmount } = await render(
      React.createElement(PcaAgentList, { ...baseProps, ownerIsPrimary: false, ownerTitle: 'Owner-only' }),
    );
    const remove = findBtn(container, 'Remove')!;
    expect(remove.disabled).toBe(true);
    expect(remove.getAttribute('title')).toBe('Owner-only');
    await unmount();
  });

  it('Remove asks for confirm; the consequence-naming confirm fires onConfirmRemove(addr)', async () => {
    const onAskRemove = vi.fn();
    const onConfirmRemove = vi.fn();
    // First render: Remove triggers onAskRemove(addr).
    const r1 = await render(React.createElement(PcaAgentList, { ...baseProps, onAskRemove }));
    await act(async () => { findBtn(r1.container, 'Remove')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onAskRemove).toHaveBeenCalledWith(NODE);
    await r1.unmount();

    // Confirming state: the consequence copy + deregister anchor; Yes fires onConfirmRemove(addr).
    const r2 = await render(React.createElement(PcaAgentList, { ...baseProps, confirmRemove: NODE, onConfirmRemove }));
    expect(r2.container.textContent).toContain('will pay the direct cost');
    const yes = r2.container.querySelector('[data-testid="pca-deregister-btn"]') as HTMLButtonElement;
    expect(yes).toBeTruthy();
    await act(async () => { yes.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onConfirmRemove).toHaveBeenCalledWith(NODE);
    await r2.unmount();
  });

  // D (#1357) — removing one of THIS node's own wallets names that consequence;
  // removing an external approved wallet keeps the generic copy.
  it('confirm names "this node’s own signing wallets" only for node-owned rows', async () => {
    const own = await render(React.createElement(PcaAgentList, { ...baseProps, confirmRemove: NODE }));
    expect(own.container.textContent).toContain('one of this node’s own signing wallets');
    await own.unmount();

    const ext = await render(React.createElement(PcaAgentList, { ...baseProps, confirmRemove: EXTERNAL }));
    expect(ext.container.textContent).not.toContain('one of this node’s own signing wallets');
    expect(ext.container.textContent).toContain('will pay the direct cost'); // generic copy
    await ext.unmount();
  });

  // D3 (#1357 a11y) — trailing controls carry a per-address accessible name.
  it('trailing Remove / Confirm / Cancel buttons have per-address aria-labels', async () => {
    const idle = await render(React.createElement(PcaAgentList, { ...baseProps }));
    expect(idle.container.querySelector(`button[aria-label="Remove ${NODE}"]`)).toBeTruthy();
    expect(idle.container.querySelector(`button[aria-label="Remove ${EXTERNAL}"]`)).toBeTruthy();
    await idle.unmount();

    const confirming = await render(React.createElement(PcaAgentList, { ...baseProps, confirmRemove: NODE }));
    expect(confirming.container.querySelector(`button[aria-label="Confirm removing ${NODE}"]`)).toBeTruthy();
    expect(confirming.container.querySelector(`button[aria-label="Cancel removing ${NODE}"]`)).toBeTruthy();
    await confirming.unmount();
  });

  it('renders a per-address explorer link only when an explorer base is provided', async () => {
    const r1 = await render(React.createElement(PcaAgentList, { ...baseProps, explorer: 'https://exp' }));
    const link = r1.container.querySelector('a.v10-pca-card-explorer') as HTMLAnchorElement;
    expect(link?.getAttribute('href')).toBe(`https://exp/address/${NODE}`);
    await r1.unmount();

    const r2 = await render(React.createElement(PcaAgentList, { ...baseProps, explorer: null }));
    expect(r2.container.querySelector('a.v10-pca-card-explorer')).toBeNull();
    await r2.unmount();
  });
});
