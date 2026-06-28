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

  // M4 — a transient 500/network on a MIDDLE wallet must NOT abort and must NOT
  // tally as a benign skip: that row is a danger-tone failure, the loop continues,
  // and the remaining wallet still gets approved.
  it('continues past a mid-batch 500 (danger failure, never skip) and approves the rest', async () => {
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...snap(), probedKey: { key, registered: false } } : snap(),
    );
    mocks.pcaAddAgent.mockImplementation(async (id: string, addr: string) => {
      if (addr === ADDR_B) throw new HttpError(500, 'x', { error: 'addPublishingAgent failed: boom' });
      return { accountId: id, agent: addr, registered: true, adapterSupported: true };
    });

    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    setTextarea(container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, [ADDR_A, ADDR_B, ADDR_C].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);

    await waitForText(container, 'failed');
    // All three attempted — the 500 did NOT abort the batch (contrast: 403).
    expect(mocks.pcaAddAgent).toHaveBeenCalledTimes(3);

    const results = container.querySelector('.v10-pca-approve-results')!;
    const rowFor = (addr: string) =>
      Array.from(results.querySelectorAll('.v10-pca-wallet-row')).find(
        (r) => r.getAttribute('aria-label')?.startsWith(addr),
      )!;
    expect(rowFor(ADDR_A).querySelector('.v10-pca-wallet-status')?.textContent).toContain('approved');
    expect(rowFor(ADDR_C).querySelector('.v10-pca-wallet-status')?.textContent).toContain('approved');
    const bStatus = rowFor(ADDR_B).querySelector('.v10-pca-wallet-status')!;
    expect(bStatus.getAttribute('data-tone')).toBe('danger');
    expect(bStatus.textContent?.toLowerCase()).not.toContain('skipped');
    // Tallied as a failure, separate from skip/conflict.
    expect(results.textContent).toContain('1 failed');
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

  // N5/#9 — AgentAlreadyRegistered disambiguation must only assert a cross-account
  // CONFLICT (danger) on a POSITIVE not-registered-here probe. A failed probe or an
  // adapter capability gap is "couldn't verify" — neutral, not a false DANGER
  // pointing at the wrong fix (deregister elsewhere).
  async function runAlreadyRegistered(probeImpl: (key?: string) => Promise<unknown>) {
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => (key ? probeImpl(key) : snap()));
    mocks.pcaAddAgent.mockRejectedValue(new HttpError(409, 'x', { error: 'AgentAlreadyRegistered' }));
    const handle = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(handle.container, 'Wallet address(es)');
    setTextarea(handle.container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, ADDR_A);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(handle.container.querySelector('[data-testid="pca-approve-submit"]')!);
    return handle;
  }
  const statusOf = (c: HTMLElement, addr: string) =>
    Array.from(c.querySelectorAll('.v10-pca-wallet-row'))
      .find((r) => r.getAttribute('aria-label')?.startsWith(addr))!
      .querySelector('.v10-pca-wallet-status')!;

  it('AgentAlreadyRegistered + probe FAILS → neutral "unverified", NOT a false conflict', async () => {
    const { container, unmount } = await runAlreadyRegistered(async () => {
      throw new Error('probe down');
    });
    await waitForText(container, 'couldn’t verify');
    const status = statusOf(container, ADDR_A);
    expect(status.getAttribute('data-tone')).toBe('neutral');
    expect(status.textContent?.toLowerCase()).not.toContain('another conviction account');
    await unmount();
  });

  it('AgentAlreadyRegistered + adapter capability gap → neutral "unverified", NOT a false conflict', async () => {
    const { container, unmount } = await runAlreadyRegistered(async (key) => ({
      ...snap(),
      probedKey: { key, registered: undefined, adapterSupported: false },
    }));
    await waitForText(container, 'couldn’t verify');
    expect(statusOf(container, ADDR_A).getAttribute('data-tone')).toBe('neutral');
    await unmount();
  });

  // U1 — the raw count > cap must NOT hard-block submit: already-approved-here
  // addresses consume no slot and the FE can't know that pre-probe.
  it('U1 — a near-cap paste with an already-approved address is NOT blocked', async () => {
    // cap = 100 - 99 = 1; paste [already-approved, new] (count 2) must stay submittable.
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => {
      const base = { ...snap(), agentCount: 99 };
      return key ? { ...base, probedKey: { key, registered: key.toLowerCase() === ADDR_A.toLowerCase() } } : base;
    });
    mocks.pcaAddAgent.mockImplementation(async (id: string, addr: string) => {
      if (addr === ADDR_A) throw new HttpError(409, 'AgentAlreadyRegistered', { error: 'AgentAlreadyRegistered' });
      return { accountId: id, agent: addr, registered: true, adapterSupported: true };
    });
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    setTextarea(container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, [ADDR_A, ADDR_B].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const submit = container.querySelector('[data-testid="pca-approve-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false); // NOT hard-blocked despite count(2) > cap(1)
    await click(submit);
    await waitForText(container, 'approved');
    expect(statusOf(container, ADDR_A).textContent?.toLowerCase()).toContain('skipped'); // no slot used
    expect(statusOf(container, ADDR_B).textContent).toContain('approved');
    await unmount();
  });

  // U1 — on AgentCapReached the loop breaks; the remaining rows must be marked 'cap',
  // never left stuck on 'pending' ("approving…").
  it('U1 — over-cap all-new: first approved, the rest "cap reached" (no stuck pending)', async () => {
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => {
      const base = { ...snap(), agentCount: 99 };
      return key ? { ...base, probedKey: { key, registered: false } } : base;
    });
    mocks.pcaAddAgent.mockImplementation(async (id: string, addr: string) => {
      if (addr === ADDR_A) return { accountId: id, agent: addr, registered: true, adapterSupported: true };
      throw new HttpError(400, 'AgentCapReached', { error: 'AgentCapReached' });
    });
    const { container, unmount } = await render(
      React.createElement(ApproveWalletsModal, { accountId: '7', initialMode: 'sponsor', onClose: vi.fn() }),
    );
    await waitForText(container, 'Wallet address(es)');
    setTextarea(container.querySelector('[data-testid="pca-approve-address"]') as HTMLTextAreaElement, [ADDR_A, ADDR_B, ADDR_C].join('\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await click(container.querySelector('[data-testid="pca-approve-submit"]')!);
    await waitForText(container, 'cap reached');
    expect(statusOf(container, ADDR_A).textContent).toContain('approved');
    expect(statusOf(container, ADDR_B).textContent).toContain('cap reached');
    // ADDR_C was never attempted (loop broke) but must NOT be stuck on "approving…".
    expect(statusOf(container, ADDR_C).textContent).toContain('cap reached');
    expect(container.textContent).not.toContain('approving…');
    expect(mocks.pcaAddAgent).toHaveBeenCalledTimes(2); // A + B, then break
    await unmount();
  });
});
