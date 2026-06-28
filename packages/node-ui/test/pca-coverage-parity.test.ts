// @vitest-environment happy-dom
//
// #1344 cross-consumer PARITY (anti-drift) — the three coverage surfaces now
// share `src/ui/pca/coverage.ts` (the leaf rules that drifted across
// C1/O4/Q2/S2/U2/V3). This feeds ONE fixture (a PCA snapshot + a per-wallet
// probe) through the SINGLE `classifyCoverage` and asserts all three surfaces
// classify the SAME fixture identically — covers / registered-but-uncovered /
// inconclusive — so they can't re-diverge. Each surface keeps its own aggregation; this pins
// only their agreement on the shared leaf coverage:
//   - S5 `PublishEligibilityChip` (usePublishEligibility) → the chip verdict,
//   - S6 `GetSponsoredPanel`       → the per-wallet approval-check outcome,
//   - `usePcaOverview`             → registered / approvedCount / covered / bestBps.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWalletsBalances: vi.fn(),
  fetchPca: vi.fn(),
  fetchContextGraphs: vi.fn(),
  fetchCurrentAgent: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    fetchWalletsBalances: mocks.fetchWalletsBalances,
    fetchPca: mocks.fetchPca,
    fetchContextGraphs: mocks.fetchContextGraphs,
    fetchCurrentAgent: mocks.fetchCurrentAgent,
  };
});

const { PublishEligibilityChip } = await import('../src/ui/pages/conviction/PublishEligibilityChip.js');
const { GetSponsoredPanel } = await import('../src/ui/pages/conviction/GetSponsoredPanel.js');
const { usePcaOverview } = await import('../src/ui/hooks/usePcaOverview.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { makePcaSnapshot } = await import('../src/ui/mocks/pca.js');
const { classifyCoverage } = await import('../src/ui/pca/coverage.js');
import type { PcaOverview } from '../src/ui/hooks/usePcaOverview.js';
import type { PcaSnapshot, PcaProbedKey } from '../src/ui/api.js';

const W0 = '0x71D4000000000000000000000000000000009Ac2';
const ACCOUNT = '7';

// ── shared harness helpers (mirrors the consumer tests) ──────────────────────
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
function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// usePcaOverview is a shared-poller hook — drive it through a Harness capturing
// its latest return, exactly like pca-overview-hook.test.ts.
let latestOverview: PcaOverview | null = null;
function OverviewHarness() {
  latestOverview = usePcaOverview(0); // intervalMs 0 → load once
  return null;
}
async function renderOverview() {
  latestOverview = null;
  const handle = await render(React.createElement(OverviewHarness));
  for (let i = 0; i < 80 && (latestOverview == null || latestOverview.loading); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  return handle;
}

// Wire the per-surface fetchers to ONE fixture: the account snapshot for the
// bare call, the snapshot + probe for a per-wallet call. Wallet is gas+TRAC
// funded so S5's verdict is coverage-driven (not a gas/TRAC fall-through).
function wire(snap: PcaSnapshot, probe: PcaProbedKey) {
  mocks.fetchWalletsBalances.mockResolvedValue({
    wallets: [W0],
    balances: [{ address: W0, eth: '0.1', trac: '100', symbol: 'TRAC' }],
    chainId: '84532',
    rpcUrl: null,
  });
  mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
    key ? { ...snap, probedKey: { ...probe } } : snap,
  );
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
  latestOverview = null;
  usePcaStore.setState({ trackedIds: [ACCOUNT], createPending: null });
  // S5 owner-publish escrow caveat off (not under test here).
  mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [] });
  mocks.fetchCurrentAgent.mockResolvedValue({ agentDid: 'did:dkg:agent:0x' + '9'.repeat(40) });
});
afterEach(() => { document.body.innerHTML = ''; });

const FUTURE = Math.floor(Date.now() / 1000) + 60 * 86_400;

describe('#1344 coverage parity — S5 / S6 / overview agree via the shared resolver', () => {
  it('registered + spendable → ALL THREE say "covers"', async () => {
    const snap = makePcaSnapshot({ accountId: ACCOUNT, expiresAtTimestamp: FUTURE });
    const probe: PcaProbedKey = { key: W0, registered: true };
    wire(snap, probe);
    const expected = classifyCoverage(snap, probe);
    expect(expected).toEqual({ registered: true, inconclusive: false, covers: true, dead: false, hasBudget: true });

    // overview
    const ov = await renderOverview();
    const a = latestOverview!.accounts.find((x) => x.accountId === ACCOUNT)!;
    expect(a.walletProbes[0]?.registered).toBe(true);
    expect(a.approvedCount).toBe(1);
    expect(a.probesInconclusive).toBe(false);
    expect(latestOverview!.covered).toBe(true);
    expect(latestOverview!.bestCoveringDiscountBps).toBe(snap.discountBps);
    await ov.unmount();

    // S5 chip → eligible
    const s5 = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(s5.container, 'Funded by PCA #' + ACCOUNT);
    expect(s5.container.querySelector('[data-verdict="eligible"]')).toBeTruthy();
    await s5.unmount();

    // S6 panel → covers → Ready
    const s6 = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(s6.container, 'Track your approval');
    setInputValue(s6.container.querySelector('input[aria-label="Sponsor account id"]') as HTMLInputElement, ACCOUNT);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => {
      (Array.from(s6.container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForText(s6.container, 'Ready');
    await s6.unmount();
  });

  it('adapterSupported:false → ALL THREE say "inconclusive" (never a confirmed not-approved/DANGER)', async () => {
    const snap = makePcaSnapshot({ accountId: ACCOUNT, expiresAtTimestamp: FUTURE });
    const probe: PcaProbedKey = { key: W0, registered: false, adapterSupported: false };
    wire(snap, probe);
    const expected = classifyCoverage(snap, probe);
    expect(expected).toEqual({ registered: null, inconclusive: true, covers: false, dead: false, hasBudget: true });

    // overview → inconclusive, not 0-approved-confirmed, not covered
    const ov = await renderOverview();
    const a = latestOverview!.accounts.find((x) => x.accountId === ACCOUNT)!;
    expect(a.walletProbes[0]?.registered).toBeNull();
    expect(a.approvedCount).toBe(0);
    expect(a.probesInconclusive).toBe(true);
    expect(latestOverview!.covered).toBe(false);
    await ov.unmount();

    // S5 chip → unknown (neutral), NOT danger
    const s5 = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(s5.container, 'PCA status unknown');
    expect(s5.container.querySelector('[data-verdict="unknown"]')).toBeTruthy();
    expect(s5.container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeNull();
    expect(s5.container.querySelector('[data-verdict="eligible"]')).toBeNull();
    await s5.unmount();

    // S6 panel → neutral row, never "not approved", never Ready
    const s6 = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(s6.container, 'Track your approval');
    setInputValue(s6.container.querySelector('input[aria-label="Sponsor account id"]') as HTMLInputElement, ACCOUNT);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => {
      (Array.from(s6.container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // All probed wallets inconclusive (adapterSupported:false) → S6 reports a
    // wholesale "couldn't determine" (never a false "not approved"/"0 of N",
    // never Ready) — the inconclusive outcome, consistent with S5 + overview.
    await waitForText(s6.container, 'the chain lookup failed');
    expect(s6.container.textContent).not.toContain('Ready');
    expect(s6.container.textContent).not.toContain('0 of 1');
    await s6.unmount();
  });

  it('zero-budget approved → ALL THREE say "registered but NONE covers"', async () => {
    const snap = makePcaSnapshot({ accountId: ACCOUNT, expiresAtTimestamp: FUTURE, topUpBuffer: '0', topUpBufferTrac: '0', baseEpochAllowance: '0' });
    const probe: PcaProbedKey = { key: W0, registered: true };
    wire(snap, probe);
    const expected = classifyCoverage(snap, probe);
    expect(expected).toEqual({ registered: true, inconclusive: false, covers: false, dead: false, hasBudget: false });

    // overview → registered (approvedCount 1) but NOT covered, no advertised discount
    const ov = await renderOverview();
    const a = latestOverview!.accounts.find((x) => x.accountId === ACCOUNT)!;
    expect(a.walletProbes[0]?.registered).toBe(true);
    expect(a.approvedCount).toBe(1);
    expect(a.probesInconclusive).toBe(false);
    expect(latestOverview!.covered).toBe(false);
    expect(latestOverview!.bestCoveringDiscountBps).toBeNull();
    await ov.unmount();

    // S5 chip → fall-through (no discount), NOT eligible (covers:false); wallet has
    // TRAC so it's amber, not danger.
    const s5 = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(s5.container, 'No PCA discount');
    expect(s5.container.querySelector('[data-verdict="fallthrough"]')).toBeTruthy();
    expect(s5.container.querySelector('[data-verdict="eligible"]')).toBeNull();
    await s5.unmount();

    // S6 panel → registered counted, but NOT Ready (the account can't cover)
    const s6 = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
    await waitForText(s6.container, 'Track your approval');
    setInputValue(s6.container.querySelector('input[aria-label="Sponsor account id"]') as HTMLInputElement, ACCOUNT);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => {
      (Array.from(s6.container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForText(s6.container, 'Approved on PCA #' + ACCOUNT);
    expect(s6.container.textContent).not.toContain('Ready');
    await s6.unmount();
  });
});
