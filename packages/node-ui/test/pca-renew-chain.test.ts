// @vitest-environment happy-dom
//
// D2 — the S2b RENEW CHAIN (ConvictionDetailView): after the replacement mint, the
// detail view resolves the OLD account's approved wallets (listPcaAgents) and opens
// the chained Approve modal SEEDED with them, in 'sponsor' mode. The two child modals
// are mocked to capture props, isolating the chain wiring (onRenewSuccess → renewApprove)
// from the create/approve internals (each covered in its own suite).

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchPca: vi.fn(),
  fetchWalletsBalances: vi.fn(),
  fetchContextGraphs: vi.fn(),
  listPcaAgents: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, ...mocks };
});

// Capture the props the chain hands each modal (isolate the chain from modal internals).
let createProps: any = null;
let approveProps: any = null;
vi.mock('../src/ui/pages/conviction/CreatePcaModal.js', () => ({
  CreatePcaModal: (props: any) => {
    createProps = props;
    return React.createElement(
      'button',
      { 'data-testid': 'mock-create-approve', onClick: () => props.onApproveOwnWallets('42') },
      'mock: approve own wallets',
    );
  },
}));
vi.mock('../src/ui/pages/conviction/ApproveWalletsModal.js', () => ({
  ApproveWalletsModal: (props: any) => {
    approveProps = props;
    return React.createElement(
      'div',
      { 'data-testid': 'mock-approve' },
      `id=${props.accountId} mode=${props.initialMode} seed=${props.seedBulk ?? ''}`,
    );
  },
}));

const { ConvictionDetailView } = await import('../src/ui/pages/conviction/ConvictionDetailView.js');
const { useAgentsStore } = await import('../src/ui/stores/agents.js');

const W0 = '0x9A3f000000000000000000000000000000000E41D';
const OLD_AGENT_A = '0xAAa0000000000000000000000000000000000001';
const OLD_AGENT_B = '0xBbB0000000000000000000000000000000000002';

function snap(over: Record<string, unknown> = {}) {
  return {
    accountId: '7', owner: W0, committedTRAC: '0', committedTRACTrac: '100000.0',
    baseEpochAllowance: '850000000000000000000', topUpBuffer: '0', topUpBufferTrac: '12500.0',
    createdAtEpoch: 1, expiresAtEpoch: 1560, createdAtTimestamp: 1, expiresAtTimestamp: 9_999_999_999,
    discountBps: 3000, agentCount: 4, lastSettledWindow: 1283, fullySwept: false, ...over,
  };
}

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function waitForText(c: HTMLElement, text: string) {
  const started = Date.now(); let last = '';
  while (Date.now() - started < 1500) {
    last = c.textContent ?? '';
    if (last.includes(text)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error(`Timed out waiting for "${text}" in "${last}"`);
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  createProps = null;
  approveProps = null;
  useAgentsStore.getState().setNodeStatus({ blockExplorerUrl: null });
  mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [] });
  mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
    key ? { ...snap(), probedKey: { key, registered: true } } : snap(),
  );
  mocks.fetchWalletsBalances.mockResolvedValue({
    wallets: [W0], balances: [{ address: W0, eth: '1', trac: '5', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null,
  });
  mocks.listPcaAgents.mockResolvedValue({ accountId: '7', agents: [OLD_AGENT_A, OLD_AGENT_B] });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('ConvictionDetailView S2b — renew chain', () => {
  it('after the replacement mint, opens Approve seeded with the OLD account’s agents', async () => {
    const { container, unmount } = await render(React.createElement(ConvictionDetailView, { accountId: '7' }));
    await waitForText(container, 'Lifecycle');

    // Open the seeded replacement-create modal (owner-gated; owner == wallets[0]).
    const renewBtn = container.querySelector('[data-testid="pca-renew-btn"]') as HTMLButtonElement;
    expect(renewBtn).toBeTruthy();
    expect(renewBtn.disabled).toBe(false);
    await act(async () => { renewBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const createApprove = container.querySelector('[data-testid="mock-create-approve"]') as HTMLButtonElement;
    expect(createApprove).toBeTruthy();
    expect(createProps.replacingAccountId).toBe('7');
    expect(createProps.seed?.tokens).toBe('100000.0'); // seeded from this account's committed amount

    // Simulate the mint's "approve own wallets" success → the renew chain.
    await act(async () => { createApprove.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'id=42'); // the chained Approve modal opened for the NEW id

    // It resolved the OLD account's agents and seeded the sponsor bulk-paste with them.
    expect(mocks.listPcaAgents).toHaveBeenCalledWith('7');
    expect(approveProps.accountId).toBe('42');
    expect(approveProps.initialMode).toBe('sponsor');
    expect(approveProps.seedBulk).toBe(`${OLD_AGENT_A}\n${OLD_AGENT_B}`);
    await unmount();
  });
});
