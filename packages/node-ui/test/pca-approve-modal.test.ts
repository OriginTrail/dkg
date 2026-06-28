// @vitest-environment happy-dom
//
// C2 — ApproveWalletsModal: the per-row outcome mapping (the §5.4 step-5
// invariant that a cross-account 409 is a CONFLICT, never a benign "skipped"),
// and the 403 owner-gate abort. Mocks pcaAddAgent + the follow-up fetchPca probe.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWalletsBalances: vi.fn(),
  fetchPca: vi.fn(),
  pcaAddAgent: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    fetchWalletsBalances: mocks.fetchWalletsBalances,
    fetchPca: mocks.fetchPca,
    pcaAddAgent: mocks.pcaAddAgent,
  };
});

const { HttpError } = await import('../src/ui/api.js');
const { ApproveWalletsModal } = await import('../src/ui/pages/conviction/ApproveWalletsModal.js');

const ADDR_A = '0x' + 'a'.repeat(40);
const ADDR_B = '0x' + 'b'.repeat(40);
const ADDR_C = '0x' + 'c'.repeat(40);

function snap(over: Record<string, unknown> = {}) {
  return {
    accountId: '7', owner: '0xowner', committedTRAC: '0', committedTRACTrac: '0',
    baseEpochAllowance: '0', topUpBuffer: '0', topUpBufferTrac: '0',
    createdAtEpoch: 1, expiresAtEpoch: 2, createdAtTimestamp: 1, expiresAtTimestamp: 9_999_999_999,
    discountBps: 3000, agentCount: 4, lastSettledWindow: 0, fullySwept: false, ...over,
  };
}

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return {
    container,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}
async function waitForText(c: HTMLElement, text: string) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 2000) {
    last = c.textContent ?? '';
    if (last.includes(text)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error(`Timed out waiting for "${text}" in "${last}"`);
}
function setTextarea(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  mocks.fetchWalletsBalances.mockResolvedValue({ wallets: ['0xnode1'], balances: [], chainId: '84532', rpcUrl: null });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('ApproveWalletsModal — per-row mapping', () => {
  it('maps approved / already-here-skip / cross-account-conflict distinctly (conflict ≠ skip)', async () => {
    // Snapshot (no key) → agentCount; probes (with key) → registered iff ADDR_B.
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => {
      if (!key) return snap();
      return { ...snap(), probedKey: { key, registered: key.toLowerCase() === ADDR_B.toLowerCase() } };
    });
    mocks.pcaAddAgent.mockImplementation(async (id: string, addr: string) => {
      if (addr === ADDR_A) return { accountId: id, agent: addr, registered: true, adapterSupported: true };
      // B + C both already registered somewhere → 409; the probe disambiguates.
      throw new HttpError(409, 'AgentAlreadyRegistered', { error: 'AgentAlreadyRegistered' });
    });

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    const ta = container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement;
    setTextarea(ta, [ADDR_A, ADDR_B, ADDR_C].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'conflict');

    const results = container.querySelector('.v10-pca-approve-results')!;
    const rowFor = (addr: string) =>
      Array.from(results.querySelectorAll('.v10-pca-wallet-row')).find(
        (r) => r.getAttribute('aria-label')?.startsWith(addr),
      )!;
    // ADDR_A approved.
    expect(rowFor(ADDR_A).querySelector('.v10-pca-wallet-status')?.textContent).toContain('approved');
    // ADDR_B registered HERE → benign skip.
    expect(rowFor(ADDR_B).querySelector('.v10-pca-wallet-status')?.textContent?.toLowerCase()).toContain('skipped');
    // ADDR_C bound ELSEWHERE → conflict, NOT a benign skip (the load-bearing invariant).
    const cStatus = rowFor(ADDR_C).querySelector('.v10-pca-wallet-status')!;
    expect(cStatus.getAttribute('data-tone')).toBe('danger');
    expect(cStatus.textContent?.toLowerCase()).not.toContain('skipped');
    expect(cStatus.textContent?.toLowerCase()).toContain('another conviction account');
    // Summary tallies the conflict separately.
    expect(results.textContent).toContain('1 conflict');
    await unmount();
  });

  it('aborts the whole operation on a 403 owner-gate failure', async () => {
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...snap(), probedKey: { key, registered: false } } : snap(),
    );
    mocks.pcaAddAgent.mockRejectedValue(new HttpError(403, 'x', { error: 'NotAccountOwner — daemon EOA is not the PCA owner' }));

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    setTextarea(container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, [ADDR_A, ADDR_B].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);

    await waitForText(container, "isn’t the owner of PCA #7");
    // Aborted after the FIRST failure — the second wallet was never attempted.
    expect(mocks.pcaAddAgent).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
